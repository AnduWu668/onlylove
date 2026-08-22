import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import {
  AgentRunError,
  type AgentEngine,
} from "../agent-engine/engine.js";
import type { AgentJobs } from "../agent-engine/jobs.js";
import type { MatchingConnections } from "../connections/matching.js";
import type {
  MatchingMember,
  MatchingMembers,
} from "../members/matching.js";
import type { MatchingModeration } from "../moderation/matching.js";
import type {
  MatchingPortraits,
  PublishedMatchingPortrait,
} from "../portraits/matching.js";
import {
  PORTRAIT_DIMENSIONS,
  type PortraitDimension,
} from "../portraits/questions.js";
import {
  deterministicPairStatus,
  type PairEvaluationInput,
  type StructuredMatchCriteria,
} from "./evaluation.js";
import {
  candidateRecommendations,
  matchingFollowupQuestions,
  matchingSettings,
  matchingSettingsAudits,
  pairEvaluations,
  recommendationDailyRuns,
  recommendationPairJobs,
} from "./schema.js";

const DEFAULT_CANDIDATE_CAPACITY = 5;
const MATCHING_RUBRIC_VERSION = "matching-rubric-v0";
const MATCHING_RUBRIC = readFileSync(
  new URL("../../../../agent/matching-rubric.md", import.meta.url),
  "utf8",
).trim();
const MATCHING_THRESHOLD = JSON.parse(
  readFileSync(
    new URL("../../../../agent/matching-threshold.json", import.meta.url),
    "utf8",
  ),
) as {
  rubricVersion: string;
  minimumReciprocalScore: number;
};
if (
  MATCHING_THRESHOLD.rubricVersion !== MATCHING_RUBRIC_VERSION ||
  !Number.isFinite(MATCHING_THRESHOLD.minimumReciprocalScore)
) {
  throw new Error("匹配阈值与评判规则版本不一致");
}
const JOB_LEASE_MS = 2 * 60_000;
const JOB_HEARTBEAT_MS = 30_000;
const MAX_JOB_ATTEMPTS = 3;
const CAPACITY_STATUSES = ["pending", "rechecking"] as const;

type Criteria = NonNullable<MatchingMember["criteria"]>;
type PortraitVersion = PublishedMatchingPortrait["version"];

interface MatchContext {
  member: MatchingMember;
  criteria: Criteria;
  portrait: PortraitVersion;
}

interface Qualification {
  eligible: boolean;
  reasons: string[];
  context?: MatchContext;
}

export class MatchingError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 409,
    readonly detail?: unknown,
  ) {
    super(code);
  }
}

function beijingDateParts(value: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(value)
      .map(({ type, value: part }) => [type, part]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

function beijingDate(value: Date) {
  const { year, month, day } = beijingDateParts(value);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function ageOn(birthDate: string | null, at: Date) {
  if (!birthDate) return null;
  const [year, month, day] = birthDate.split("-").map(Number);
  const current = beijingDateParts(at);
  return (
    current.year -
    year! -
    (current.month < month! ||
    (current.month === month! && current.day < day!)
      ? 1
      : 0)
  );
}

function structuredCriteria(
  context: MatchContext,
  at: Date,
): StructuredMatchCriteria {
  return {
    version: context.criteria.version,
    member: {
      gender: context.member.gender,
      age: ageOn(context.member.birthDate, at),
      heightCm: context.member.heightCm,
      city: context.member.city,
      occupation: context.member.occupation,
    },
    desiredGender: context.criteria.desiredGender,
    ageMinimum: context.criteria.ageMinimum,
    ageMaximum: context.criteria.ageMaximum,
    ageMode: context.criteria.ageMode,
    heightMinimumCm: context.criteria.heightMinimumCm,
    heightMaximumCm: context.criteria.heightMaximumCm,
    heightMode: context.criteria.heightMode,
    acceptableCities: context.criteria.acceptableCities,
    occupationRequirement: context.criteria.occupationRequirement,
    occupationMode: context.criteria.occupationMode,
  };
}

function pairInput(
  memberA: MatchContext,
  memberB: MatchContext,
  at: Date,
): PairEvaluationInput {
  return {
    memberA: {
      matchProfile: memberA.portrait.matchProfile,
      structuredCriteria: structuredCriteria(memberA, at),
    },
    memberB: {
      matchProfile: memberB.portrait.matchProfile,
      structuredCriteria: structuredCriteria(memberB, at),
    },
    rubric: { version: MATCHING_RUBRIC_VERSION, content: MATCHING_RUBRIC },
  };
}

function publicRecommendationReason(
  member: MatchContext,
  candidate: MatchContext,
) {
  return member.member.city === candidate.member.city
    ? `你们目前都在${candidate.member.city}生活，双方的明确条件已通过核对，可以进一步了解。`
    : `对方目前在${candidate.member.city}生活，双方的明确条件已通过核对，可以进一步了解。`;
}

const DIMENSION_QUESTIONS: Record<PortraitDimension, string> = {
  long_term_planning: "请补充你面对长期生活规划变化时通常怎样判断和协商。",
  values: "请补充你在长期关系中最重视、也最不能接受的价值选择。",
  relationship_boundaries: "请补充你在亲密关系中需要对方尊重的边界。",
  communication: "请补充你遇到重要分歧时偏好的沟通方式。",
  conflict_repair: "请补充冲突发生后，你通常怎样推动修复。",
  emotional_support: "请补充你需要和愿意提供的情感支持方式。",
  lifestyle: "请补充哪些生活方式差异会影响你长期相处。",
  family_and_finance: "请补充你对家庭责任和财务安排的基本边界。",
};

export class Matching {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date,
    private readonly agentJobs: AgentJobs,
    private readonly matchingDefinition: AgentEngine["matchingDefinition"],
    private readonly matchingMembers: MatchingMembers,
    private readonly matchingPortraits: MatchingPortraits,
    private readonly matchingModeration: MatchingModeration,
    private readonly matchingConnections: MatchingConnections,
  ) {}

  async settings() {
    const at = this.now();
    await this.db
      .insert(matchingSettings)
      .values({
        id: 1,
        candidateCapacity: DEFAULT_CANDIDATE_CAPACITY,
        minimumReciprocalScore: MATCHING_THRESHOLD.minimumReciprocalScore,
        updatedAt: at,
      })
      .onConflictDoNothing({ target: matchingSettings.id });
    return (
      await this.db
        .select()
        .from(matchingSettings)
        .where(eq(matchingSettings.id, 1))
        .limit(1)
    )[0]!;
  }

  async updateSettings(
    actorId: string,
    input: { candidateCapacity: number; minimumReciprocalScore: number },
  ) {
    await this.settings();
    const at = this.now();
    const updated = await this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext('matching-settings'))`,
      );
      const current = (
        await transaction
          .select()
          .from(matchingSettings)
          .where(eq(matchingSettings.id, 1))
          .limit(1)
      )[0]!;
      const saved = (
        await transaction
          .update(matchingSettings)
          .set({ ...input, updatedBy: actorId, updatedAt: at })
          .where(eq(matchingSettings.id, 1))
          .returning()
      )[0]!;
      await transaction.insert(matchingSettingsAudits).values({
        id: randomUUID(),
        actorId,
        previousCapacity: current.candidateCapacity,
        previousMinimumScore: current.minimumReciprocalScore,
        ...input,
        createdAt: at,
      });
      return saved;
    });
    const affected = await this.db
      .selectDistinct({ memberId: candidateRecommendations.memberId })
      .from(candidateRecommendations)
      .where(
        or(
          eq(candidateRecommendations.status, "pending"),
          eq(candidateRecommendations.status, "rechecking"),
        ),
      );
    for (const { memberId } of affected) {
      try {
        await this.recheckForMember(memberId);
      } catch (error) {
        console.error("Recommendation recheck after settings save failed", {
          memberId,
          error,
        });
      }
    }
    return updated;
  }

  settingsAudit() {
    return this.db
      .select()
      .from(matchingSettingsAudits)
      .orderBy(desc(matchingSettingsAudits.createdAt));
  }

  private async qualifications(memberIds: string[]) {
    const ids = [...new Set(memberIds)];
    const [
      members,
      portraits,
      currentContacts,
      recoveringMembers,
      restrictedMembers,
    ] =
      await Promise.all([
        this.matchingMembers.byIds(ids),
        this.matchingPortraits.publishedFor(ids),
        this.matchingConnections.membersWithCurrent(ids),
        this.matchingConnections.membersRecovering(ids),
        this.matchingModeration.restrictedMembers(ids),
      ]);
    const byId = new Map(members.map((member) => [member.id, member]));
    const result = new Map<string, Qualification>();
    for (const memberId of ids) {
      const reasons: string[] = [];
      const member = byId.get(memberId);
      if (!member) {
        result.set(memberId, {
          eligible: false,
          reasons: ["account_unavailable"],
        });
        continue;
      }
      if (
        !member.nickname ||
        !member.birthDate ||
        !member.gender ||
        !member.heightCm ||
        !member.city ||
        !member.occupation
      ) {
        reasons.push("profile_incomplete");
      }
      if (!member.criteria) reasons.push("match_criteria_missing");
      const published = portraits.get(memberId);
      if (!published) reasons.push("portrait_not_published");
      if (
        published &&
        PORTRAIT_DIMENSIONS.some(
          (dimension) =>
            !["medium", "high"].includes(
              published.version.matchProfile.dimensions[dimension]?.confidence,
            ),
        )
      ) {
        reasons.push("portrait_dimensions_incomplete");
      }
      if (published) {
        if (
          published.calibration.length !== 10 ||
          published.calibration.filter(({ rating }) => rating === "like")
            .length < 8
        ) {
          reasons.push("calibration_incomplete");
        }
        if (
          published.calibration.some(
            ({ criticalFabrication }) => criticalFabrication,
          )
        ) {
          reasons.push("critical_fabrication");
        }
      }
      if (currentContacts.has(memberId)) reasons.push("current_contact");
      if (recoveringMembers.has(memberId)) reasons.push("relationship_recovery");
      if (restrictedMembers.has(memberId)) reasons.push("moderation_restricted");
      result.set(memberId, {
        eligible: reasons.length === 0,
        reasons,
        context:
          reasons.length === 0
            ? ({
                member,
                criteria: member.criteria!,
                portrait: published!.version,
              } satisfies MatchContext)
            : undefined,
      });
    }
    return result;
  }

  private async qualification(memberId: string) {
    return (await this.qualifications([memberId])).get(memberId)!;
  }

  private async screenPair(memberA: MatchContext, memberB: MatchContext) {
    if (
      await this.matchingModeration.blocked(
        memberA.member.id,
        memberB.member.id,
      )
    ) {
      return undefined;
    }
    return this.deterministicPair(memberA, memberB);
  }

  private deterministicPair(memberA: MatchContext, memberB: MatchContext) {
    const input = pairInput(memberA, memberB, this.now());
    return deterministicPairStatus(input) === "pass" ? input : undefined;
  }

  private async cachedEvaluation(
    memberA: MatchContext,
    memberB: MatchContext,
    database: Database | DatabaseTransaction = this.db,
  ) {
    return (
      await database
        .select()
        .from(pairEvaluations)
        .where(
          and(
            eq(pairEvaluations.memberAId, memberA.member.id),
            eq(pairEvaluations.memberBId, memberB.member.id),
            eq(pairEvaluations.portraitVersionAId, memberA.portrait.id),
            eq(pairEvaluations.portraitVersionBId, memberB.portrait.id),
            eq(pairEvaluations.criteriaVersionAId, memberA.criteria.id),
            eq(pairEvaluations.criteriaVersionBId, memberB.criteria.id),
            eq(pairEvaluations.rubricVersion, MATCHING_RUBRIC_VERSION),
          ),
        )
        .limit(1)
    )[0];
  }

  private pairVersionCondition(memberA: MatchContext, memberB: MatchContext) {
    const direct = and(
      eq(candidateRecommendations.memberId, memberA.member.id),
      eq(candidateRecommendations.candidateMemberId, memberB.member.id),
      eq(candidateRecommendations.memberPortraitVersionId, memberA.portrait.id),
      eq(
        candidateRecommendations.candidatePortraitVersionId,
        memberB.portrait.id,
      ),
      eq(candidateRecommendations.memberCriteriaVersionId, memberA.criteria.id),
      eq(
        candidateRecommendations.candidateCriteriaVersionId,
        memberB.criteria.id,
      ),
    );
    const reverse = and(
      eq(candidateRecommendations.memberId, memberB.member.id),
      eq(candidateRecommendations.candidateMemberId, memberA.member.id),
      eq(candidateRecommendations.memberPortraitVersionId, memberB.portrait.id),
      eq(
        candidateRecommendations.candidatePortraitVersionId,
        memberA.portrait.id,
      ),
      eq(candidateRecommendations.memberCriteriaVersionId, memberB.criteria.id),
      eq(
        candidateRecommendations.candidateCriteriaVersionId,
        memberA.criteria.id,
      ),
    );
    return and(
      ne(candidateRecommendations.status, "removed"),
      or(direct, reverse),
    );
  }

  private async hasPairVersionRecommendation(
    memberA: MatchContext,
    memberB: MatchContext,
  ) {
    return Boolean(
      (
        await this.db
          .select({ id: candidateRecommendations.id })
          .from(candidateRecommendations)
          .where(this.pairVersionCondition(memberA, memberB))
          .limit(1)
      )[0],
    );
  }

  private async enqueueEvaluation(
    memberA: MatchContext,
    memberB: MatchContext,
    options: { runDate?: string; recommendationId?: string },
  ) {
    const input = pairInput(memberA, memberB, this.now());
    const at = this.now();
    return this.db.transaction(async (transaction) => {
      if (options.recommendationId) {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext(${options.recommendationId}))`,
        );
        const existing = (
          await transaction
            .select()
            .from(recommendationPairJobs)
            .where(
              and(
                eq(
                  recommendationPairJobs.recommendationId,
                  options.recommendationId,
                ),
                eq(recommendationPairJobs.status, "pending"),
                eq(
                  recommendationPairJobs.memberPortraitVersionId,
                  memberA.portrait.id,
                ),
                eq(
                  recommendationPairJobs.candidatePortraitVersionId,
                  memberB.portrait.id,
                ),
                eq(
                  recommendationPairJobs.memberCriteriaVersionId,
                  memberA.criteria.id,
                ),
                eq(
                  recommendationPairJobs.candidateCriteriaVersionId,
                  memberB.criteria.id,
                ),
              ),
            )
            .limit(1)
        )[0];
        if (existing) return existing;
      }
      const cached = await this.cachedEvaluation(memberA, memberB, transaction);
      const base = {
        id: randomUUID(),
        memberId: memberA.member.id,
        candidateMemberId: memberB.member.id,
        runDate: options.runDate,
        recommendationId: options.recommendationId,
        pairEvaluationId: cached?.id,
        memberPortraitVersionId: memberA.portrait.id,
        candidatePortraitVersionId: memberB.portrait.id,
        memberCriteriaVersionId: memberA.criteria.id,
        candidateCriteriaVersionId: memberB.criteria.id,
        input,
        status: cached ? ("completed" as const) : ("pending" as const),
        createdAt: at,
        updatedAt: at,
      };
      if (cached) {
        return (
          await transaction
            .insert(recommendationPairJobs)
            .values(base)
            .returning()
        )[0]!;
      }
      const job = await this.agentJobs.enqueueMatching({
        transaction,
        memberId: memberA.member.id,
        profileVersionId: memberA.portrait.id,
        definition: this.matchingDefinition,
        createdAt: at,
      });
      return (
        await transaction
          .insert(recommendationPairJobs)
          .values({ ...base, agentJobId: job.id })
          .returning()
      )[0]!;
    });
  }

  private async addFollowupQuestions(
    evaluation: typeof pairEvaluations.$inferSelect,
    input: PairEvaluationInput,
    memberAId: string,
    memberBId: string,
  ) {
    const values: (typeof matchingFollowupQuestions.$inferInsert)[] = [];
    for (const item of evaluation.result.dimensions) {
      if (item.hardBoundaryStatus !== "needs_more_information") continue;
      const a = input.memberA.matchProfile.dimensions[item.dimension];
      const b = input.memberB.matchProfile.dimensions[item.dimension];
      if (a.confidence === "high" && a.hardBoundary?.trim()) {
        values.push({
          id: randomUUID(),
          memberId: memberBId,
          pairEvaluationId: evaluation.id,
          questionKey: item.dimension,
          question: DIMENSION_QUESTIONS[item.dimension],
          createdAt: this.now(),
        });
      }
      if (b.confidence === "high" && b.hardBoundary?.trim()) {
        values.push({
          id: randomUUID(),
          memberId: memberAId,
          pairEvaluationId: evaluation.id,
          questionKey: item.dimension,
          question: DIMENSION_QUESTIONS[item.dimension],
          createdAt: this.now(),
        });
      }
    }
    if (
      evaluation.result.structuredConditionStatus === "needs_more_information"
    ) {
      if (
        input.memberA.structuredCriteria.occupationMode === "required" &&
        input.memberA.structuredCriteria.occupationRequirement
      ) {
        values.push({
          id: randomUUID(),
          memberId: memberBId,
          pairEvaluationId: evaluation.id,
          questionKey: "occupation",
          question: "请补充职业安排会怎样影响你对长期关系的期待和边界。",
          createdAt: this.now(),
        });
      }
      if (
        input.memberB.structuredCriteria.occupationMode === "required" &&
        input.memberB.structuredCriteria.occupationRequirement
      ) {
        values.push({
          id: randomUUID(),
          memberId: memberAId,
          pairEvaluationId: evaluation.id,
          questionKey: "occupation",
          question: "请补充职业安排会怎样影响你对长期关系的期待和边界。",
          createdAt: this.now(),
        });
      }
    }
    if (values.length) {
      await this.db
        .insert(matchingFollowupQuestions)
        .values(values)
        .onConflictDoNothing();
    }
  }

  private async reserveDailyRun(memberId: string) {
    const at = this.now();
    const runDate = beijingDate(at);
    await this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${memberId}:${runDate}:recommendations`}))`,
      );
      const current = (
        await transaction
          .select()
          .from(recommendationDailyRuns)
          .where(
            and(
              eq(recommendationDailyRuns.memberId, memberId),
              eq(recommendationDailyRuns.runDate, runDate),
            ),
          )
          .limit(1)
      )[0];
      if (current?.status === "running" || current?.status === "completed") {
        throw new MatchingError("RECOMMENDATIONS_ALREADY_REQUESTED_TODAY");
      }
      if (current) {
        await transaction
          .update(recommendationDailyRuns)
          .set({ status: "running", createdAt: at, completedAt: null })
          .where(
            and(
              eq(recommendationDailyRuns.memberId, memberId),
              eq(recommendationDailyRuns.runDate, runDate),
            ),
          );
      } else {
        await transaction.insert(recommendationDailyRuns).values({
          memberId,
          runDate,
          status: "running",
          createdAt: at,
        });
      }
    });
    return runDate;
  }

  private async markDailyRun(
    memberId: string,
    runDate: string,
    status: "completed" | "failed",
  ) {
    await this.db
      .update(recommendationDailyRuns)
      .set({
        status,
        completedAt: status === "completed" ? this.now() : null,
      })
      .where(
        and(
          eq(recommendationDailyRuns.memberId, memberId),
          eq(recommendationDailyRuns.runDate, runDate),
        ),
      );
  }

  private async evaluationById(id: string) {
    return (
      await this.db
        .select()
        .from(pairEvaluations)
        .where(eq(pairEvaluations.id, id))
        .limit(1)
    )[0];
  }

  private contextMatchesRequest(
    context: MatchContext,
    request: typeof recommendationPairJobs.$inferSelect,
    side: "member" | "candidate",
  ) {
    return (
      context.portrait.id === request[`${side}PortraitVersionId`] &&
      context.criteria.id === request[`${side}CriteriaVersionId`]
    );
  }

  private async finalizeDailyRun(memberId: string, runDate: string) {
    const requests = await this.db
      .select()
      .from(recommendationPairJobs)
      .where(
        and(
          eq(recommendationPairJobs.memberId, memberId),
          eq(recommendationPairJobs.runDate, runDate),
        ),
      );
    if (requests.some(({ status }) => status === "pending")) return false;
    if (
      requests.length &&
      requests.every(({ status }) => status === "failed")
    ) {
      await this.markDailyRun(memberId, runDate, "failed");
      return true;
    }
    const settings = await this.settings();
    const existing = await this.db
      .select({ id: candidateRecommendations.id })
      .from(candidateRecommendations)
      .where(
        and(
          eq(candidateRecommendations.memberId, memberId),
          inArray(candidateRecommendations.status, [...CAPACITY_STATUSES]),
        ),
      );
    const available = Math.max(
      0,
      settings.candidateCapacity - existing.length,
    );
    const eligible: {
      request: typeof recommendationPairJobs.$inferSelect;
      evaluation: typeof pairEvaluations.$inferSelect;
      reason: string;
    }[] = [];
    const qualificationById = await this.qualifications(
      requests.flatMap((request) => [
        request.memberId,
        request.candidateMemberId,
      ]),
    );
    const blockedCandidates = await this.matchingModeration.blockedCandidates(
      memberId,
      requests.map(({ candidateMemberId }) => candidateMemberId),
    );
    for (const request of requests) {
      if (request.status !== "completed" || !request.pairEvaluationId) continue;
      const evaluation = await this.evaluationById(request.pairEvaluationId);
      if (!evaluation) continue;
      await this.addFollowupQuestions(
        evaluation,
        request.input,
        request.memberId,
        request.candidateMemberId,
      );
      if (
        evaluation.result.eligibility !== "eligible" ||
        evaluation.result.reciprocalScore < settings.minimumReciprocalScore
      ) {
        continue;
      }
      const member = qualificationById.get(request.memberId)!;
      const candidate = qualificationById.get(request.candidateMemberId)!;
      if (!member.eligible || !candidate.eligible) continue;
      if (
        !this.contextMatchesRequest(member.context!, request, "member") ||
        !this.contextMatchesRequest(candidate.context!, request, "candidate") ||
        blockedCandidates.has(request.candidateMemberId) ||
        !this.deterministicPair(member.context!, candidate.context!) ||
        (await this.hasPairVersionRecommendation(
          member.context!,
          candidate.context!,
        ))
      ) {
        continue;
      }
      eligible.push({
        request,
        evaluation,
        reason: publicRecommendationReason(member.context!, candidate.context!),
      });
    }
    eligible.sort(
      (left, right) =>
        right.evaluation.result.reciprocalScore -
        left.evaluation.result.reciprocalScore,
    );
    const at = this.now();
    for (const { request, evaluation, reason } of eligible.slice(
      0,
      available,
    )) {
      await this.db
        .insert(candidateRecommendations)
        .values({
          id: randomUUID(),
          memberId: request.memberId,
          candidateMemberId: request.candidateMemberId,
          pairEvaluationId: evaluation.id,
          memberPortraitVersionId: request.memberPortraitVersionId,
          candidatePortraitVersionId: request.candidatePortraitVersionId,
          memberCriteriaVersionId: request.memberCriteriaVersionId,
          candidateCriteriaVersionId: request.candidateCriteriaVersionId,
          reason,
          status: "pending",
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoNothing();
    }
    await this.markDailyRun(memberId, runDate, "completed");
    return true;
  }

  async generate(memberId: string) {
    const qualificationResult = await this.qualification(memberId);
    if (!qualificationResult.eligible) {
      throw new MatchingError(
        "RECOMMENDATION_NOT_ELIGIBLE",
        409,
        qualificationResult.reasons,
      );
    }
    const runDate = await this.reserveDailyRun(memberId);
    try {
      await this.recheckForMember(memberId);
      const settings = await this.settings();
      const occupying = await this.db
        .select({ id: candidateRecommendations.id })
        .from(candidateRecommendations)
        .where(
          and(
            eq(candidateRecommendations.memberId, memberId),
            inArray(candidateRecommendations.status, [...CAPACITY_STATUSES]),
          ),
        );
      if (occupying.length < settings.candidateCapacity) {
        const candidates = await this.matchingMembers.candidates(memberId);
        const qualificationById = await this.qualifications(
          candidates.map(({ id }) => id),
        );
        const blockedCandidates = await this.matchingModeration.blockedCandidates(
          memberId,
          candidates.map(({ id }) => id),
        );
        // ponytail: linear MVP scan; preselect in SQL when the member pool makes this slow.
        for (const candidate of candidates) {
          const candidateQualification = qualificationById.get(candidate.id)!;
          if (!candidateQualification.eligible) continue;
          const input = this.deterministicPair(
            qualificationResult.context!,
            candidateQualification.context!,
          );
          if (
            blockedCandidates.has(candidate.id) ||
            !input ||
            (await this.hasPairVersionRecommendation(
              qualificationResult.context!,
              candidateQualification.context!,
            ))
          ) {
            continue;
          }
          await this.enqueueEvaluation(
            qualificationResult.context!,
            candidateQualification.context!,
            { runDate },
          );
        }
      }
      await this.finalizeDailyRun(memberId, runDate);
      return this.state(memberId);
    } catch (error) {
      await this.markDailyRun(memberId, runDate, "failed");
      throw error;
    }
  }

  private async cards(memberId: string) {
    const rows = await this.db
      .select({ recommendation: candidateRecommendations })
      .from(candidateRecommendations)
      .where(
        and(
          eq(candidateRecommendations.memberId, memberId),
          eq(candidateRecommendations.status, "pending"),
        ),
      )
      .orderBy(asc(candidateRecommendations.createdAt));
    const members = await this.matchingMembers.byIds(
      rows.map(({ recommendation }) => recommendation.candidateMemberId),
    );
    const byId = new Map(members.map((member) => [member.id, member]));
    const cards = [];
    for (const { recommendation } of rows) {
      const candidate = byId.get(recommendation.candidateMemberId);
      if (!candidate) continue;
      cards.push({
        id: recommendation.id,
        avatarText: candidate.nickname?.trim().slice(0, 1) || "爱",
        nickname: candidate.nickname!,
        age: ageOn(candidate.birthDate, this.now()),
        heightCm: candidate.heightCm!,
        city: candidate.city!,
        occupation: candidate.occupation!,
        reason: recommendation.reason,
      });
    }
    return cards;
  }

  async state(memberId: string) {
    await this.recheckForMember(memberId);
    const [
      qualificationResult,
      settings,
      candidates,
      occupying,
      questions,
      dailyRun,
    ] = await Promise.all([
        this.qualification(memberId),
        this.settings(),
        this.cards(memberId),
        this.db
          .select({ status: candidateRecommendations.status })
          .from(candidateRecommendations)
          .where(
            and(
              eq(candidateRecommendations.memberId, memberId),
              inArray(candidateRecommendations.status, [...CAPACITY_STATUSES]),
            ),
          ),
        this.db
          .select({
            id: matchingFollowupQuestions.id,
            question: matchingFollowupQuestions.question,
          })
          .from(matchingFollowupQuestions)
          .where(eq(matchingFollowupQuestions.memberId, memberId))
          .orderBy(asc(matchingFollowupQuestions.createdAt)),
        this.db
          .select({ status: recommendationDailyRuns.status })
          .from(recommendationDailyRuns)
          .where(
            and(
              eq(recommendationDailyRuns.memberId, memberId),
              eq(recommendationDailyRuns.runDate, beijingDate(this.now())),
            ),
          )
          .limit(1),
      ]);
    const runStatus = dailyRun[0]?.status;
    return {
      eligibility: {
        eligible: qualificationResult.eligible,
        reasons: qualificationResult.reasons,
      },
      capacity: settings.candidateCapacity,
      remainingCapacity: Math.max(
        0,
        settings.candidateCapacity - occupying.length,
      ),
      dailyFetchAvailable:
        qualificationResult.eligible &&
        runStatus !== "running" &&
        runStatus !== "completed",
      generating:
        runStatus === "running" ||
        occupying.some(({ status }) => status === "rechecking"),
      generationFailed: runStatus === "failed",
      candidates,
      followupQuestions: questions,
    };
  }

  async candidateForTwinConversation(
    memberId: string,
    recommendationId: string,
    expectedCandidateMemberId?: string,
    transaction?: DatabaseTransaction,
  ) {
    const database = transaction ?? this.db;
    const recommendation = (
      await database
        .select()
        .from(candidateRecommendations)
        .where(
          and(
            eq(candidateRecommendations.id, recommendationId),
            eq(candidateRecommendations.memberId, memberId),
            inArray(candidateRecommendations.status, [...CAPACITY_STATUSES]),
          ),
        )
        .limit(1)
    )[0];
    if (!recommendation) return undefined;
    const members = await this.matchingMembers.byIds(
      [memberId, recommendation.candidateMemberId],
      database,
    );
    const byId = new Map(members.map((member) => [member.id, member]));
    if (
      (expectedCandidateMemberId &&
        recommendation.candidateMemberId !== expectedCandidateMemberId) ||
      byId.get(memberId)?.criteria?.id !==
        recommendation.memberCriteriaVersionId ||
      byId.get(recommendation.candidateMemberId)?.criteria?.id !==
        recommendation.candidateCriteriaVersionId ||
      (await this.matchingModeration.recommendationRestricted(
        memberId,
        recommendation.candidateMemberId,
        transaction,
      )) ||
      (await this.matchingModeration.blocked(
        memberId,
        recommendation.candidateMemberId,
        transaction,
      ))
    ) {
      return undefined;
    }
    return recommendation.candidateMemberId;
  }

  async skip(memberId: string, id: string) {
    return Boolean(
      (
        await this.db
          .update(candidateRecommendations)
          .set({ status: "skipped", updatedAt: this.now() })
          .where(
            and(
              eq(candidateRecommendations.id, id),
              eq(candidateRecommendations.memberId, memberId),
              eq(candidateRecommendations.status, "pending"),
            ),
          )
          .returning({ id: candidateRecommendations.id })
      )[0],
    );
  }

  private sameRequestVersions(
    recommendation: typeof candidateRecommendations.$inferSelect,
    member: MatchContext,
    candidate: MatchContext,
  ) {
    return (
      recommendation.memberPortraitVersionId === member.portrait.id &&
      recommendation.candidatePortraitVersionId === candidate.portrait.id &&
      recommendation.memberCriteriaVersionId === member.criteria.id &&
      recommendation.candidateCriteriaVersionId === candidate.criteria.id
    );
  }

  private async applyRecheck(
    request: typeof recommendationPairJobs.$inferSelect,
  ) {
    if (!request.recommendationId || !request.pairEvaluationId) return;
    const [evaluation, qualificationById, settings] = await Promise.all([
      this.evaluationById(request.pairEvaluationId),
      this.qualifications([request.memberId, request.candidateMemberId]),
      this.settings(),
    ]);
    const member = qualificationById.get(request.memberId)!;
    const candidate = qualificationById.get(request.candidateMemberId)!;
    if (!evaluation || !member.eligible || !candidate.eligible) {
      await this.removeRecommendation(request.recommendationId);
      return;
    }
    const stillCurrent =
      this.contextMatchesRequest(member.context!, request, "member") &&
      this.contextMatchesRequest(candidate.context!, request, "candidate");
    if (!stillCurrent) return;
    await this.addFollowupQuestions(
      evaluation,
      request.input,
      request.memberId,
      request.candidateMemberId,
    );
    const keep =
      Boolean(await this.screenPair(member.context!, candidate.context!)) &&
      evaluation.result.eligibility === "eligible" &&
      evaluation.result.reciprocalScore >= settings.minimumReciprocalScore;
    if (!keep) {
      await this.removeRecommendation(request.recommendationId);
      return;
    }
    await this.db
      .update(candidateRecommendations)
      .set({
        pairEvaluationId: evaluation.id,
        memberPortraitVersionId: request.memberPortraitVersionId,
        candidatePortraitVersionId: request.candidatePortraitVersionId,
        memberCriteriaVersionId: request.memberCriteriaVersionId,
        candidateCriteriaVersionId: request.candidateCriteriaVersionId,
        reason: publicRecommendationReason(member.context!, candidate.context!),
        status: "pending",
        updatedAt: this.now(),
      })
      .where(eq(candidateRecommendations.id, request.recommendationId));
  }

  private async removeRecommendation(id: string) {
    await this.db
      .update(candidateRecommendations)
      .set({ status: "removed", updatedAt: this.now() })
      .where(eq(candidateRecommendations.id, id));
  }

  async recheckForMember(changedMemberId: string) {
    const settings = await this.settings();
    const recommendations = await this.db
      .select()
      .from(candidateRecommendations)
      .where(
        and(
          or(
            eq(candidateRecommendations.status, "pending"),
            eq(candidateRecommendations.status, "rechecking"),
          ),
          or(
            eq(candidateRecommendations.memberId, changedMemberId),
            eq(candidateRecommendations.candidateMemberId, changedMemberId),
          ),
        ),
      );
    const qualificationById = await this.qualifications(
      recommendations.flatMap((recommendation) => [
        recommendation.memberId,
        recommendation.candidateMemberId,
      ]),
    );
    const otherMemberId = (
      recommendation: typeof candidateRecommendations.$inferSelect,
    ) =>
      recommendation.memberId === changedMemberId
        ? recommendation.candidateMemberId
        : recommendation.memberId;
    const blockedMembers = await this.matchingModeration.blockedCandidates(
      changedMemberId,
      recommendations.map(otherMemberId),
    );
    for (const recommendation of recommendations) {
      const member = qualificationById.get(recommendation.memberId)!;
      const candidate = qualificationById.get(
        recommendation.candidateMemberId,
      )!;
      if (
        !member.eligible ||
        !candidate.eligible ||
        blockedMembers.has(otherMemberId(recommendation)) ||
        !this.deterministicPair(member.context!, candidate.context!)
      ) {
        await this.removeRecommendation(recommendation.id);
        continue;
      }
      if (
        this.sameRequestVersions(
          recommendation,
          member.context!,
          candidate.context!,
        )
      ) {
        const evaluation = await this.evaluationById(
          recommendation.pairEvaluationId,
        );
        if (
          !evaluation ||
          evaluation.result.eligibility !== "eligible" ||
          evaluation.result.reciprocalScore < settings.minimumReciprocalScore
        ) {
          await this.removeRecommendation(recommendation.id);
        } else if (recommendation.status === "rechecking") {
          await this.db
            .update(candidateRecommendations)
            .set({ status: "pending", updatedAt: this.now() })
            .where(eq(candidateRecommendations.id, recommendation.id));
        }
        continue;
      }
      await this.db
        .update(candidateRecommendations)
        .set({ status: "rechecking", updatedAt: this.now() })
        .where(eq(candidateRecommendations.id, recommendation.id));
      const request = await this.enqueueEvaluation(
        member.context!,
        candidate.context!,
        { recommendationId: recommendation.id },
      );
      if (request.status === "completed") await this.applyRecheck(request);
    }
    const kept = await this.db
      .select({
        id: candidateRecommendations.id,
        result: pairEvaluations.result,
        createdAt: candidateRecommendations.createdAt,
      })
      .from(candidateRecommendations)
      .innerJoin(
        pairEvaluations,
        eq(pairEvaluations.id, candidateRecommendations.pairEvaluationId),
      )
      .where(
        and(
          eq(candidateRecommendations.memberId, changedMemberId),
          inArray(candidateRecommendations.status, [...CAPACITY_STATUSES]),
        ),
      );
    kept.sort(
      (left, right) =>
        right.result.reciprocalScore - left.result.reciprocalScore ||
        left.createdAt.getTime() - right.createdAt.getTime(),
    );
    for (const extra of kept.slice(settings.candidateCapacity)) {
      await this.removeRecommendation(extra.id);
    }
  }

  async processNextEvaluationJob(agentEngine: AgentEngine) {
    const candidate = await this.agentJobs.nextMatchingJob(this.now());
    if (!candidate) return false;
    const startedAt = this.now();
    const claimed = await this.agentJobs.claim(
      candidate.id,
      startedAt,
      new Date(startedAt.getTime() + JOB_LEASE_MS),
      { retryFailed: true },
    );
    if (!claimed) return true;
    const heartbeat = setInterval(() => {
      const at = this.now();
      void this.agentJobs
        .heartbeat(claimed, new Date(at.getTime() + JOB_LEASE_MS))
        .catch(() => undefined);
    }, JOB_HEARTBEAT_MS);
    heartbeat.unref();
    const request = (
      await this.db
        .select()
        .from(recommendationPairJobs)
        .where(eq(recommendationPairJobs.agentJobId, claimed.id))
        .limit(1)
    )[0];
    try {
      if (!request) throw new Error("MATCHING_INPUT_MISSING");
      let completedRequest = request;
      if (!request.pairEvaluationId) {
        const run = await agentEngine.evaluatePair(request.input, (attempts) =>
          this.agentJobs.recordAttempts(
            claimed,
            attempts,
            this.now(),
            agentEngine.matchingDefinition,
          ),
        );
        completedRequest = await this.db.transaction(async (transaction) => {
          const evaluation = (
            await transaction
              .insert(pairEvaluations)
              .values({
                id: randomUUID(),
                memberAId: request.memberId,
                memberBId: request.candidateMemberId,
                portraitVersionAId: request.memberPortraitVersionId,
                portraitVersionBId: request.candidatePortraitVersionId,
                criteriaVersionAId: request.memberCriteriaVersionId,
                criteriaVersionBId: request.candidateCriteriaVersionId,
                agentJobId: claimed.id,
                rubricVersion: MATCHING_RUBRIC_VERSION,
                result: run.value,
                createdAt: this.now(),
              })
              .returning()
          )[0]!;
          return (
            await transaction
              .update(recommendationPairJobs)
              .set({
                pairEvaluationId: evaluation.id,
                status: "completed",
                updatedAt: this.now(),
              })
              .where(eq(recommendationPairJobs.id, request.id))
              .returning()
          )[0]!;
        });
      } else if (request.status !== "completed") {
        completedRequest = (
          await this.db
            .update(recommendationPairJobs)
            .set({ status: "completed", updatedAt: this.now() })
            .where(eq(recommendationPairJobs.id, request.id))
            .returning()
        )[0]!;
      }
      if (completedRequest.recommendationId) {
        await this.applyRecheck(completedRequest);
      } else if (completedRequest.runDate) {
        await this.finalizeDailyRun(
          completedRequest.memberId,
          completedRequest.runDate,
        );
      }
      await this.db.transaction(async (transaction) => {
        const completed = await this.agentJobs.complete(
          transaction,
          claimed,
          null,
          claimed.retryCount,
          claimed.switchedModel,
          this.now(),
        );
        if (!completed) throw new Error("AGENT_JOB_LEASE_LOST");
      });
    } catch (error) {
      const runError = error instanceof AgentRunError ? error : undefined;
      const retryCount = claimed.retryCount + 1;
      await this.db.transaction((transaction) =>
        this.agentJobs.fail(
          transaction,
          claimed,
          runError?.code ?? "MODEL_REQUEST_FAILED",
          retryCount,
          claimed.switchedModel || (runError?.switchedModel ?? false),
          false,
          this.now(),
        ),
      );
      if (request && retryCount >= MAX_JOB_ATTEMPTS) {
        await this.db
          .update(recommendationPairJobs)
          .set({ status: "failed", updatedAt: this.now() })
          .where(eq(recommendationPairJobs.id, request.id));
        if (request.recommendationId) {
          await this.removeRecommendation(request.recommendationId);
        } else if (request.runDate) {
          await this.finalizeDailyRun(request.memberId, request.runDate);
        }
      }
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }
}
