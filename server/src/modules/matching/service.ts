import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  and,
  asc,
  desc,
  eq,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "../../db.js";
import {
  AgentRunError,
  type AgentEngine,
} from "../agent-engine/engine.js";
import type { AgentJobs } from "../agent-engine/jobs.js";
import { members, matchCriteriaVersions } from "../members/schema.js";
import { portraitCalibrationAnswers, portraitCalibrationScenarios, portraitMemberStates, portraitVersions } from "../portraits/schema.js";
import { PORTRAIT_DIMENSIONS, type PortraitDimension } from "../portraits/questions.js";
import {
  deterministicPairStatus,
  type PairEvaluationInput,
  type PairEvaluationResult,
  type StructuredMatchCriteria,
} from "./evaluation.js";
import {
  candidateRecommendations,
  matchingFollowupQuestions,
  matchingSettings,
  matchingSettingsAudits,
  memberBlocks,
  memberConnections,
  pairEvaluations,
  recommendationDailyRuns,
} from "./schema.js";

const DEFAULT_CANDIDATE_CAPACITY = 5;
const DEFAULT_MINIMUM_RECIPROCAL_SCORE = 60;
const MATCHING_RUBRIC_VERSION = "matching-rubric-v0";
const MATCHING_RUBRIC = readFileSync(
  new URL("../../../../agent/matching-rubric.md", import.meta.url),
  "utf8",
).trim();

type Member = typeof members.$inferSelect;
type Criteria = typeof matchCriteriaVersions.$inferSelect;
type PortraitVersion = typeof portraitVersions.$inferSelect;

interface MatchContext {
  member: Member;
  criteria: Criteria;
  portrait: PortraitVersion;
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

function ageOn(birthDate: string | null, at: Date) {
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
    private readonly agentEngine: AgentEngine,
    private readonly agentJobs: AgentJobs,
  ) {}

  async settings() {
    const at = this.now();
    await this.db
      .insert(matchingSettings)
      .values({
        id: 1,
        candidateCapacity: DEFAULT_CANDIDATE_CAPACITY,
        minimumReciprocalScore: DEFAULT_MINIMUM_RECIPROCAL_SCORE,
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
    const at = this.now();
    const updated = await this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext('matching-settings'))`,
      );
      const current = await this.settings();
      const updated = (
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
      return updated;
    });
    const affected = await this.db
      .selectDistinct({ memberId: candidateRecommendations.memberId })
      .from(candidateRecommendations)
      .where(eq(candidateRecommendations.status, "pending"));
    for (const { memberId } of affected) {
      await this.recheckForMember(memberId);
    }
    return updated;
  }

  settingsAudit() {
    return this.db
      .select()
      .from(matchingSettingsAudits)
      .orderBy(desc(matchingSettingsAudits.createdAt));
  }

  private async latestCriteria(memberId: string) {
    return (
      await this.db
        .select()
        .from(matchCriteriaVersions)
        .where(eq(matchCriteriaVersions.memberId, memberId))
        .orderBy(desc(matchCriteriaVersions.version))
        .limit(1)
    )[0];
  }

  private async qualification(memberId: string) {
    const reasons: string[] = [];
    const member = (
      await this.db
        .select()
        .from(members)
        .where(
          and(
            eq(members.id, memberId),
            eq(members.role, "member"),
            isNull(members.deletedAt),
          ),
        )
        .limit(1)
    )[0];
    if (!member) return { eligible: false, reasons: ["account_unavailable"] };
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
    const criteria = await this.latestCriteria(memberId);
    if (!criteria) reasons.push("match_criteria_missing");
    const state = (
      await this.db
        .select()
        .from(portraitMemberStates)
        .where(eq(portraitMemberStates.memberId, memberId))
        .limit(1)
    )[0];
    const portrait = state?.publishedVersionId
      ? (
          await this.db
            .select()
            .from(portraitVersions)
            .where(eq(portraitVersions.id, state.publishedVersionId))
            .limit(1)
        )[0]
      : undefined;
    if (!portrait) reasons.push("portrait_not_published");
    if (
      portrait &&
      PORTRAIT_DIMENSIONS.some(
        (dimension) =>
          !["medium", "high"].includes(
            portrait.matchProfile.dimensions[dimension]?.confidence,
          ),
      )
    ) {
      reasons.push("portrait_dimensions_incomplete");
    }
    if (portrait) {
      const answers = await this.db
        .select({
          rating: portraitCalibrationAnswers.rating,
          criticalFabrication: portraitCalibrationAnswers.criticalFabrication,
        })
        .from(portraitCalibrationScenarios)
        .innerJoin(
          portraitCalibrationAnswers,
          eq(
            portraitCalibrationAnswers.scenarioId,
            portraitCalibrationScenarios.id,
          ),
        )
        .where(
          eq(portraitCalibrationScenarios.portraitVersionId, portrait.id),
        );
      if (
        answers.length !== 10 ||
        answers.filter(({ rating }) => rating === "like").length < 8
      ) {
        reasons.push("calibration_incomplete");
      }
      if (answers.some(({ criticalFabrication }) => criticalFabrication)) {
        reasons.push("critical_fabrication");
      }
    }
    const activeConnection = (
      await this.db
        .select({ id: memberConnections.id })
        .from(memberConnections)
        .where(
          and(
            eq(memberConnections.status, "active"),
            or(
              eq(memberConnections.memberAId, memberId),
              eq(memberConnections.memberBId, memberId),
            ),
          ),
        )
        .limit(1)
    )[0];
    if (activeConnection) reasons.push("current_contact");
    return {
      eligible: reasons.length === 0,
      reasons,
      context:
        reasons.length === 0
          ? ({ member, criteria: criteria!, portrait: portrait! } satisfies MatchContext)
          : undefined,
    };
  }

  private async blocked(memberAId: string, memberBId: string) {
    return Boolean(
      (
        await this.db
          .select({ blockerMemberId: memberBlocks.blockerMemberId })
          .from(memberBlocks)
          .where(
            or(
              and(
                eq(memberBlocks.blockerMemberId, memberAId),
                eq(memberBlocks.blockedMemberId, memberBId),
              ),
              and(
                eq(memberBlocks.blockerMemberId, memberBId),
                eq(memberBlocks.blockedMemberId, memberAId),
              ),
            ),
          )
          .limit(1)
      )[0],
    );
  }

  private async cachedEvaluation(memberA: MatchContext, memberB: MatchContext) {
    return (
      await this.db
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

  private async evaluate(memberA: MatchContext, memberB: MatchContext) {
    const cached = await this.cachedEvaluation(memberA, memberB);
    if (cached) return cached;
    const createdAt = this.now();
    const definition = this.agentEngine.matchingDefinition;
    const job = await this.db.transaction((transaction) =>
      this.agentJobs.create(transaction, {
        id: randomUUID(),
        role: definition.role,
        task: definition.task,
        definitionVersion: definition.version,
        promptVersion: definition.promptVersion,
        schemaVersion: definition.schemaVersion,
        memberId: memberA.member.id,
        profileVersionId: memberA.portrait.id,
        status: "pending",
        retryCount: 0,
        switchedModel: false,
        quotaRefunded: false,
        createdAt,
      }),
    );
    const claimed = await this.agentJobs.claim(
      job.id,
      createdAt,
      new Date(createdAt.getTime() + 2 * 60_000),
    );
    if (!claimed) throw new MatchingError("MATCHING_UNAVAILABLE", 503);
    try {
      const run = await this.agentEngine.evaluatePair(
        pairInput(memberA, memberB, createdAt),
        (attempts) =>
          this.agentJobs.recordAttempts(claimed, attempts, this.now(), definition),
      );
      await this.db.transaction((transaction) =>
        this.agentJobs.complete(
          transaction,
          claimed,
          null,
          Math.max(0, run.attempts.length - 1),
          run.attempts.some((attempt) => attempt.switchedModel),
          this.now(),
        ),
      );
      return (
        await this.db
          .insert(pairEvaluations)
          .values({
            id: randomUUID(),
            memberAId: memberA.member.id,
            memberBId: memberB.member.id,
            portraitVersionAId: memberA.portrait.id,
            portraitVersionBId: memberB.portrait.id,
            criteriaVersionAId: memberA.criteria.id,
            criteriaVersionBId: memberB.criteria.id,
            rubricVersion: MATCHING_RUBRIC_VERSION,
            result: run.value,
            createdAt,
          })
          .returning()
      )[0]!;
    } catch (error) {
      const failure =
        error instanceof AgentRunError
          ? error
          : new AgentRunError("MATCHING_FAILED");
      await this.db.transaction((transaction) =>
        this.agentJobs.fail(
          transaction,
          claimed,
          failure.code,
          failure.retryCount,
          failure.switchedModel,
          false,
          this.now(),
        ),
      );
      throw new MatchingError("MATCHING_UNAVAILABLE", 503);
    }
  }

  private async addFollowupQuestions(
    evaluation: typeof pairEvaluations.$inferSelect,
    memberA: MatchContext,
    memberB: MatchContext,
  ) {
    const values: (typeof matchingFollowupQuestions.$inferInsert)[] = [];
    for (const item of evaluation.result.dimensions) {
      if (item.hardBoundaryStatus !== "needs_more_information") continue;
      const a = memberA.portrait.matchProfile.dimensions[item.dimension];
      const b = memberB.portrait.matchProfile.dimensions[item.dimension];
      if (
        a.confidence === "high" &&
        a.hardBoundary?.trim() &&
        !b.selfTendency?.trim()
      ) {
        values.push({
          id: randomUUID(),
          memberId: memberB.member.id,
          pairEvaluationId: evaluation.id,
          questionKey: item.dimension,
          question: DIMENSION_QUESTIONS[item.dimension],
          createdAt: this.now(),
        });
      }
      if (
        b.confidence === "high" &&
        b.hardBoundary?.trim() &&
        !a.selfTendency?.trim()
      ) {
        values.push({
          id: randomUUID(),
          memberId: memberA.member.id,
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
      for (const context of [memberA, memberB]) {
        values.push({
          id: randomUUID(),
          memberId: context.member.id,
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

  private exactRecommendationCondition(
    memberA: MatchContext,
    memberB: MatchContext,
  ) {
    return and(
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
  }

  private async hasExactRecommendation(
    memberA: MatchContext,
    memberB: MatchContext,
    excludingId?: string,
  ) {
    return Boolean(
      (
        await this.db
          .select({ id: candidateRecommendations.id })
          .from(candidateRecommendations)
          .where(
            and(
              this.exactRecommendationCondition(memberA, memberB),
              excludingId
                ? ne(candidateRecommendations.id, excludingId)
                : undefined,
            ),
          )
          .limit(1)
      )[0],
    );
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

  private async finishDailyRun(
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

  async generate(memberId: string) {
    const member = await this.qualification(memberId);
    if (!member.eligible) {
      throw new MatchingError(
        "RECOMMENDATION_NOT_ELIGIBLE",
        409,
        member.reasons,
      );
    }
    const runDate = await this.reserveDailyRun(memberId);
    try {
      const settings = await this.settings();
      const pending = await this.db
        .select({ id: candidateRecommendations.id })
        .from(candidateRecommendations)
        .where(
          and(
            eq(candidateRecommendations.memberId, memberId),
            eq(candidateRecommendations.status, "pending"),
          ),
        );
      const available = Math.max(
        0,
        settings.candidateCapacity - pending.length,
      );
      if (available) {
        const candidates = await this.db
          .select({ id: members.id })
          .from(members)
          .where(
            and(
              ne(members.id, memberId),
              eq(members.role, "member"),
              isNull(members.deletedAt),
            ),
          );
        const evaluated: {
          context: MatchContext;
          evaluation: typeof pairEvaluations.$inferSelect;
        }[] = [];
        // ponytail: linear MVP scan; preselect/rank in SQL when the member pool makes this slow.
        for (const candidate of candidates) {
          const qualified = await this.qualification(candidate.id);
          if (!qualified.eligible) continue;
          const candidateContext = qualified.context!;
          if (await this.blocked(memberId, candidate.id)) continue;
          if (
            deterministicPairStatus(
              pairInput(member.context!, candidateContext, this.now()),
            ) !== "pass"
          ) {
            continue;
          }
          if (
            await this.hasExactRecommendation(member.context!, candidateContext)
          ) {
            continue;
          }
          const evaluation = await this.evaluate(
            member.context!,
            candidateContext,
          );
          if (evaluation.result.eligibility === "needs_more_information") {
            await this.addFollowupQuestions(
              evaluation,
              member.context!,
              candidateContext,
            );
          }
          if (
            evaluation.result.eligibility === "eligible" &&
            evaluation.result.reciprocalScore >=
              settings.minimumReciprocalScore
          ) {
            evaluated.push({ context: candidateContext, evaluation });
          }
        }
        evaluated.sort(
          (left, right) =>
            right.evaluation.result.reciprocalScore -
            left.evaluation.result.reciprocalScore,
        );
        const createdAt = this.now();
        for (const { context, evaluation } of evaluated.slice(0, available)) {
          await this.db.insert(candidateRecommendations).values({
            id: randomUUID(),
            memberId,
            candidateMemberId: context.member.id,
            pairEvaluationId: evaluation.id,
            memberPortraitVersionId: member.context!.portrait.id,
            candidatePortraitVersionId: context.portrait.id,
            memberCriteriaVersionId: member.context!.criteria.id,
            candidateCriteriaVersionId: context.criteria.id,
            reason: evaluation.result.safeRecommendationReason,
            status: "pending",
            createdAt,
            updatedAt: createdAt,
          });
        }
      }
      await this.finishDailyRun(memberId, runDate, "completed");
      return this.state(memberId);
    } catch (error) {
      await this.finishDailyRun(memberId, runDate, "failed");
      throw error;
    }
  }

  private async cards(memberId: string) {
    const rows = await this.db
      .select({
        recommendation: candidateRecommendations,
        candidate: members,
      })
      .from(candidateRecommendations)
      .innerJoin(
        members,
        eq(members.id, candidateRecommendations.candidateMemberId),
      )
      .where(
        and(
          eq(candidateRecommendations.memberId, memberId),
          eq(candidateRecommendations.status, "pending"),
          isNull(members.deletedAt),
        ),
      )
      .orderBy(asc(candidateRecommendations.createdAt));
    return rows.map(({ recommendation, candidate }) => ({
      id: recommendation.id,
      memberId: candidate.id,
      avatarText: candidate.nickname?.trim().slice(0, 1) || "爱",
      nickname: candidate.nickname!,
      age: ageOn(candidate.birthDate, this.now()),
      heightCm: candidate.heightCm!,
      city: candidate.city!,
      occupation: candidate.occupation!,
      reason: recommendation.reason,
    }));
  }

  async state(memberId: string) {
    await this.recheckForMember(memberId);
    const [qualification, settings, candidates, questions, dailyRun] =
      await Promise.all([
        this.qualification(memberId),
        this.settings(),
        this.cards(memberId),
        this.db
          .select({ id: matchingFollowupQuestions.id, question: matchingFollowupQuestions.question })
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
    return {
      eligibility: {
        eligible: qualification.eligible,
        reasons: qualification.reasons,
      },
      capacity: settings.candidateCapacity,
      remainingCapacity: Math.max(
        0,
        settings.candidateCapacity - candidates.length,
      ),
      dailyFetchAvailable:
        qualification.eligible &&
        !["running", "completed"].includes(dailyRun[0]?.status ?? ""),
      candidates,
      followupQuestions: questions,
    };
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

  async recheckForMember(changedMemberId: string) {
    const settings = await this.settings();
    const pending = await this.db
      .select()
      .from(candidateRecommendations)
      .where(
        and(
          eq(candidateRecommendations.status, "pending"),
          or(
            eq(candidateRecommendations.memberId, changedMemberId),
            eq(candidateRecommendations.candidateMemberId, changedMemberId),
          ),
        ),
      );
    for (const recommendation of pending) {
      const [member, candidate] = await Promise.all([
        this.qualification(recommendation.memberId),
        this.qualification(recommendation.candidateMemberId),
      ]);
      let keep = member.eligible && candidate.eligible;
      if (keep) {
        keep = !(await this.blocked(
          recommendation.memberId,
          recommendation.candidateMemberId,
        ));
      }
      if (keep) {
        keep =
          deterministicPairStatus(
            pairInput(member.context!, candidate.context!, this.now()),
          ) === "pass";
      }
      try {
        const exactExists =
          keep &&
          (await this.hasExactRecommendation(
            member.context!,
            candidate.context!,
            recommendation.id,
          ));
        if (exactExists) keep = false;
        if (keep) {
          const evaluation = await this.evaluate(
            member.context!,
            candidate.context!,
          );
          keep =
            evaluation.result.eligibility === "eligible" &&
            evaluation.result.reciprocalScore >=
              settings.minimumReciprocalScore;
          if (keep) {
            await this.db
              .update(candidateRecommendations)
              .set({
                pairEvaluationId: evaluation.id,
                memberPortraitVersionId: member.context!.portrait.id,
                candidatePortraitVersionId: candidate.context!.portrait.id,
                memberCriteriaVersionId: member.context!.criteria.id,
                candidateCriteriaVersionId: candidate.context!.criteria.id,
                reason: evaluation.result.safeRecommendationReason,
                updatedAt: this.now(),
              })
              .where(eq(candidateRecommendations.id, recommendation.id));
            continue;
          }
          if (evaluation.result.eligibility === "needs_more_information") {
            await this.addFollowupQuestions(
              evaluation,
              member.context!,
              candidate.context!,
            );
          }
        }
      } catch {
        keep = false;
      }
      if (!keep) {
        await this.db
          .update(candidateRecommendations)
          .set({ status: "removed", updatedAt: this.now() })
          .where(eq(candidateRecommendations.id, recommendation.id));
      }
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
          eq(candidateRecommendations.status, "pending"),
        ),
      );
    kept.sort(
      (left, right) =>
        right.result.reciprocalScore - left.result.reciprocalScore ||
        left.createdAt.getTime() - right.createdAt.getTime(),
    );
    for (const extra of kept.slice(settings.candidateCapacity)) {
      await this.db
        .update(candidateRecommendations)
        .set({ status: "removed", updatedAt: this.now() })
        .where(eq(candidateRecommendations.id, extra.id));
    }
  }
}
