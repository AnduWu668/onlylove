import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  or,
} from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import type {
  AgentModelOptions,
  AgentEngine,
} from "../agent-engine/engine.js";
import { agentRuns } from "../agent-engine/schema.js";
import {
  connectionFollowupResponses,
  contactRequests,
  memberConnections,
} from "../connections/schema.js";
import {
  agentQuotaSettingsAudits,
  conversationMessages,
  conversations,
} from "../conversations/schema.js";
import {
  candidateRecommendations,
  matchingSettingsAudits,
  pairEvaluations,
  recommendationDailyRuns,
  recommendationPairJobs,
} from "../matching/schema.js";
import {
  memberDeletionAudits,
  members,
  matchCriteriaVersions,
  sessions,
} from "../members/schema.js";
import {
  normalizeEmail,
  superAdminForRequest,
} from "../members/routes.js";
import {
  distortionFeedback,
  moderationCaseAccessAudits,
} from "../moderation/schema.js";
import {
  portraitCalibrationAnswers,
  portraitCalibrationScenarios,
  portraitDrafts,
  portraitMemberStates,
  portraitVersions,
} from "../portraits/schema.js";
import {
  administrationAudits,
  type AdministrationAuditAction,
} from "./schema.js";

type AuditDatabase = Database | DatabaseTransaction;

export function recordAdministrationAudit(
  db: AuditDatabase,
  input: {
    actorMemberId: string;
    action: AdministrationAuditAction;
    createdAt: Date;
    targetMemberId?: string | null;
    resourceId?: string | null;
    details?: Record<string, unknown>;
  },
) {
  return db.insert(administrationAudits).values({
    id: randomUUID(),
    targetMemberId: null,
    resourceId: null,
    details: {},
    ...input,
  });
}

function collectEvidenceIds(value: unknown, ids = new Set<string>()) {
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceIds(item, ids);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "evidenceMessageIds" && Array.isArray(item)) {
        for (const id of item) if (typeof id === "string") ids.add(id);
      } else {
        collectEvidenceIds(item, ids);
      }
    }
  }
  return ids;
}

function beijingDate(value: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function administratorView(member: typeof members.$inferSelect) {
  return {
    id: member.id,
    email: member.email,
    role: member.role,
    active: member.deletedAt === null,
    createdAt: member.createdAt.toISOString(),
  };
}

const uuidParams = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

export function registerAdministrationRoutes(
  app: FastifyInstance,
  options: {
    db: Database;
    now: () => Date;
    agentEngine: AgentEngine;
    agentModel?: AgentModelOptions;
  },
) {
  const { db, now, agentEngine, agentModel } = options;

  app.get("/api/admin/administrators", async (request, reply) => {
    const viewedAt = now();
    const actor = await superAdminForRequest(request, db, viewedAt);
    if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
    const rows = await db.transaction(async (transaction) => {
      await recordAdministrationAudit(transaction, {
        actorMemberId: actor.id,
        action: "administrator_directory_viewed",
        createdAt: viewedAt,
      });
      return transaction
        .select()
        .from(members)
        .where(eq(members.role, "admin"))
        .orderBy(desc(members.createdAt));
    });
    return { administrators: rows.map(administratorView) };
  });

  app.post<{ Body: { email: string } }>(
    "/api/admin/administrators",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email"],
          properties: {
            email: { type: "string", format: "email", maxLength: 320 },
          },
        },
      },
    },
    async (request, reply) => {
      const createdAt = now();
      const actor = await superAdminForRequest(request, db, createdAt);
      if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
      const email = normalizeEmail(request.body.email);
      const created = await db.transaction(async (transaction) => {
        const administrator = (
          await transaction
            .insert(members)
            .values({ id: randomUUID(), email, role: "admin", createdAt })
            .onConflictDoNothing({ target: members.email })
            .returning()
        )[0];
        if (!administrator) return undefined;
        await recordAdministrationAudit(transaction, {
          actorMemberId: actor.id,
          targetMemberId: administrator.id,
          action: "administrator_created",
          createdAt,
          details: { email },
        });
        return administrator;
      });
      if (!created) return reply.code(409).send({ code: "EMAIL_IN_USE" });
      return reply.code(201).send(administratorView(created));
    },
  );

  app.patch<{ Params: { id: string }; Body: { active: boolean } }>(
    "/api/admin/administrators/:id",
    {
      schema: {
        params: uuidParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["active"],
          properties: { active: { type: "boolean" } },
        },
      },
    },
    async (request, reply) => {
      const changedAt = now();
      const actor = await superAdminForRequest(request, db, changedAt);
      if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
      const administrator = await db.transaction(async (transaction) => {
        const updated = (
          await transaction
            .update(members)
            .set({ deletedAt: request.body.active ? null : changedAt })
            .where(
              and(
                eq(members.id, request.params.id),
                eq(members.role, "admin"),
                isNull(members.purgedAt),
              ),
            )
            .returning()
        )[0];
        if (!updated) return undefined;
        if (!request.body.active) {
          await transaction
            .delete(sessions)
            .where(eq(sessions.memberId, updated.id));
        }
        await recordAdministrationAudit(transaction, {
          actorMemberId: actor.id,
          targetMemberId: updated.id,
          action: request.body.active
            ? "administrator_activated"
            : "administrator_deactivated",
          createdAt: changedAt,
          details: { email: updated.email },
        });
        return updated;
      });
      if (!administrator) {
        return reply.code(404).send({ code: "ADMINISTRATOR_NOT_FOUND" });
      }
      return administratorView(administrator);
    },
  );

  app.get("/api/admin/members", async (request, reply) => {
    const viewedAt = now();
    const actor = await superAdminForRequest(request, db, viewedAt);
    if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
    const rows = await db.transaction(async (transaction) => {
      await recordAdministrationAudit(transaction, {
        actorMemberId: actor.id,
        action: "member_directory_viewed",
        createdAt: viewedAt,
      });
      return transaction
        .select({
          id: members.id,
          email: members.email,
          nickname: members.nickname,
          createdAt: members.createdAt,
          suspendedUntil: members.suspendedUntil,
          deletedAt: members.deletedAt,
        })
        .from(members)
        .where(and(eq(members.role, "member"), isNull(members.purgedAt)))
        .orderBy(desc(members.createdAt));
    });
    return { members: rows };
  });

  app.get<{ Params: { id: string } }>(
    "/api/admin/members/:id",
    { schema: { params: uuidParams } },
    async (request, reply) => {
      const viewedAt = now();
      const actor = await superAdminForRequest(request, db, viewedAt);
      if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
      const detail = await db.transaction(async (transaction) => {
        const member = (
          await transaction
            .select({
              id: members.id,
              email: members.email,
              role: members.role,
              birthDate: members.birthDate,
              nickname: members.nickname,
              gender: members.gender,
              heightCm: members.heightCm,
              city: members.city,
              occupation: members.occupation,
              createdAt: members.createdAt,
              suspendedUntil: members.suspendedUntil,
              deletedAt: members.deletedAt,
            })
            .from(members)
            .where(and(eq(members.id, request.params.id), eq(members.role, "member")))
            .limit(1)
        )[0];
        if (!member) return undefined;
        const criteria = await transaction
          .select()
          .from(matchCriteriaVersions)
          .where(eq(matchCriteriaVersions.memberId, member.id))
          .orderBy(desc(matchCriteriaVersions.version));
        const portraits = await transaction
          .select()
          .from(portraitVersions)
          .where(eq(portraitVersions.memberId, member.id))
          .orderBy(desc(portraitVersions.version));
        const memberConversations = await transaction
          .select()
          .from(conversations)
          .where(
            or(
              eq(conversations.memberId, member.id),
              eq(conversations.visitorMemberId, member.id),
            ),
          )
          .orderBy(desc(conversations.createdAt));
        const evaluations = await transaction
          .select()
          .from(pairEvaluations)
          .where(
            or(
              eq(pairEvaluations.memberAId, member.id),
              eq(pairEvaluations.memberBId, member.id),
            ),
          )
          .orderBy(desc(pairEvaluations.createdAt));
        const evidenceIds = [...collectEvidenceIds(portraits.map((item) => item.matchProfile))];
        const conversationIds = memberConversations.map(({ id }) => id);
        const evidence = evidenceIds.length
          ? await transaction
              .select()
              .from(conversationMessages)
              .where(inArray(conversationMessages.id, evidenceIds))
          : [];
        const messages = conversationIds.length
          ? await transaction
              .select()
              .from(conversationMessages)
              .where(inArray(conversationMessages.conversationId, conversationIds))
              .orderBy(conversationMessages.sequence)
          : [];
        await recordAdministrationAudit(transaction, {
          actorMemberId: actor.id,
          targetMemberId: member.id,
          action: "member_sensitive_viewed",
          createdAt: viewedAt,
        });
        return {
          member,
          matchCriteria: criteria[0] ?? null,
          portrait: portraits[0] ?? null,
          portraitVersions: portraits,
          evidence,
          conversations: memberConversations.map((conversation) => ({
            ...conversation,
            messages: messages.filter(
              (message) => message.conversationId === conversation.id,
            ),
          })),
          pairEvaluations: evaluations,
        };
      });
      if (!detail) return reply.code(404).send({ code: "MEMBER_NOT_FOUND" });
      return detail;
    },
  );

  app.get("/api/admin/dashboard", async (request, reply) => {
    const viewedAt = now();
    const actor = await superAdminForRequest(request, db, viewedAt);
    if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
    // ponytail: full-table aggregation fits the MVP; use SQL/materialized rollups when admin latency grows.
    const [
      memberRows,
      criteriaRows,
      drafts,
      states,
      calibration,
      dailyRuns,
      pairJobs,
      recommendations,
      requests,
      connections,
      followups,
      feedback,
    ] = await Promise.all([
      db.select().from(members).where(eq(members.role, "member")),
      db.select({ memberId: matchCriteriaVersions.memberId }).from(matchCriteriaVersions),
      db.select().from(portraitDrafts),
      db.select().from(portraitMemberStates),
      db
        .select({
          portraitVersionId: portraitCalibrationScenarios.portraitVersionId,
          rating: portraitCalibrationAnswers.rating,
          criticalFabrication: portraitCalibrationAnswers.criticalFabrication,
        })
        .from(portraitCalibrationAnswers)
        .innerJoin(
          portraitCalibrationScenarios,
          eq(
            portraitCalibrationScenarios.id,
            portraitCalibrationAnswers.scenarioId,
          ),
        ),
      db.select().from(recommendationDailyRuns),
      db.select().from(recommendationPairJobs),
      db.select().from(candidateRecommendations),
      db.select().from(contactRequests),
      db.select().from(memberConnections),
      db.select().from(connectionFollowupResponses),
      db.select().from(distortionFeedback),
    ]);

    const calibrationByVersion = new Map<
      string,
      { total: number; likes: number; fabrication: boolean }
    >();
    for (const answer of calibration) {
      const current = calibrationByVersion.get(answer.portraitVersionId) ?? {
        total: 0,
        likes: 0,
        fabrication: false,
      };
      current.total += 1;
      current.likes += Number(answer.rating === "like");
      current.fabrication ||= answer.criticalFabrication;
      calibrationByVersion.set(answer.portraitVersionId, current);
    }
    const completedCalibration = [...calibrationByVersion.entries()].filter(
      ([, outcome]) => outcome.total === 10,
    );
    const passedVersions = new Set(
      completedCalibration
        .filter(([, outcome]) => outcome.likes >= 8 && !outcome.fabrication)
        .map(([versionId]) => versionId),
    );
    const criteriaMembers = new Set(criteriaRows.map(({ memberId }) => memberId));
    const activeCompleteMembers = new Set(
      memberRows
        .filter(
          (member) =>
            !member.deletedAt &&
            !member.purgedAt &&
            (!member.suspendedUntil || member.suspendedUntil <= viewedAt) &&
            member.birthDate &&
            member.nickname &&
            member.gender &&
            member.city &&
            member.occupation &&
            criteriaMembers.has(member.id),
        )
        .map(({ id }) => id),
    );
    const runsWithCandidate = new Set(
      pairJobs
        .filter((job) => job.runDate && job.recommendationId)
        .map((job) => `${job.memberId}:${job.runDate}`),
    );
    const dueFollowups = new Set(
      followups.map(({ connectionId }) => connectionId),
    );
    await recordAdministrationAudit(db, {
      actorMemberId: actor.id,
      action: "dashboard_viewed",
      createdAt: viewedAt,
    });
    return {
      members: {
        registered: memberRows.filter((member) => !member.purgedAt).length,
        profileCompleted: activeCompleteMembers.size,
        portraitStarted: drafts.length,
        portraitComplete: drafts.filter((draft) => draft.completedDimensions === 8)
          .length,
        submitted: states.length,
        calibrationPassed: passedVersions.size,
        published: states.filter((state) => state.publishedVersionId).length,
        recommendationEligible: states.filter(
          (state) =>
            state.publishedVersionId &&
            passedVersions.has(state.publishedVersionId) &&
            activeCompleteMembers.has(state.memberId),
        ).length,
      },
      recommendations: {
        requested: dailyRuns.length,
        generated: recommendations.length,
        noCandidate: dailyRuns.filter(
          (run) =>
            run.status === "completed" &&
            !runsWithCandidate.has(`${run.memberId}:${run.runDate}`),
        ).length,
      },
      contacts: {
        requested: requests.length,
        accepted: requests.filter((request) => request.status === "accepted")
          .length,
        current: connections.filter((connection) => connection.status === "active")
          .length,
        ended: connections.filter((connection) => connection.status === "ended")
          .length,
        confirmed: connections.filter(
          (connection) => connection.status === "confirmed",
        ).length,
        sevenDayResponses: dueFollowups.size,
      },
      quality: {
        calibrationPassRate: completedCalibration.length
          ? Math.round((passedVersions.size / completedCalibration.length) * 10_000) /
            100
          : 0,
        criticalFabrications: calibration.filter(
          (answer) => answer.criticalFabrication,
        ).length,
        distortionFeedback: feedback.length,
      },
    };
  });

  app.get("/api/admin/agent-observability", async (request, reply) => {
    const viewedAt = now();
    const actor = await superAdminForRequest(request, db, viewedAt);
    if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
    // ponytail: in-memory grouping keeps one source of truth; move to SQL GROUP BY when run volume affects latency.
    const runs = await db.select().from(agentRuns).orderBy(desc(agentRuns.createdAt));
    type Aggregate = {
      date: string;
      role: string;
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      estimatedCostMicroCny: number;
      latencyMs: number;
      runs: number;
      failures: number;
      modelSwitches: number;
    };
    const grouped = new Map<string, Aggregate>();
    for (const run of runs) {
      const date = beijingDate(run.createdAt);
      const key = [date, run.role, run.provider, run.actualModel].join("\u0000");
      const aggregate = grouped.get(key) ?? {
        date,
        role: run.role,
        provider: run.provider,
        model: run.actualModel,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostMicroCny: 0,
        latencyMs: 0,
        runs: 0,
        failures: 0,
        modelSwitches: 0,
      };
      aggregate.inputTokens += run.inputTokens;
      aggregate.outputTokens += run.outputTokens;
      aggregate.estimatedCostMicroCny += run.estimatedCostMicroCny;
      aggregate.latencyMs += run.latencyMs;
      aggregate.runs += 1;
      aggregate.failures += Number(Boolean(run.error));
      aggregate.modelSwitches += Number(run.switchedModel);
      grouped.set(key, aggregate);
    }
    const totalLatency = runs.reduce((total, run) => total + run.latencyMs, 0);
    const microCost = runs.reduce(
      (total, run) => total + run.estimatedCostMicroCny,
      0,
    );
    const pricing = [
      ...new Map(
        runs
          .filter((run) => run.pricingEffectiveDate)
          .map((run) => [
            [run.provider, run.actualModel, run.pricingEffectiveDate].join("\u0000"),
            {
              provider: run.provider,
              model: run.actualModel,
              effectiveDate: run.pricingEffectiveDate,
              inputCostCnyPerMillionTokens:
                run.inputCostCnyPerMillionTokens,
              outputCostCnyPerMillionTokens:
                run.outputCostCnyPerMillionTokens,
            },
          ]),
      ).values(),
    ];
    await recordAdministrationAudit(db, {
      actorMemberId: actor.id,
      action: "agent_observability_viewed",
      createdAt: viewedAt,
    });
    return {
      summary: {
        inputTokens: runs.reduce((total, run) => total + run.inputTokens, 0),
        outputTokens: runs.reduce((total, run) => total + run.outputTokens, 0),
        estimatedCostCny: microCost / 1_000_000,
        averageLatencyMs: runs.length ? Math.round(totalLatency / runs.length) : 0,
        failures: runs.filter((run) => run.error).length,
        modelSwitches: runs.filter((run) => run.switchedModel).length,
      },
      groups: [...grouped.values()]
        .sort((left, right) => right.date.localeCompare(left.date))
        .map((group) => ({
          ...group,
          estimatedCostCny: group.estimatedCostMicroCny / 1_000_000,
          averageLatencyMs: Math.round(group.latencyMs / group.runs),
        })),
      pricing,
      disclaimer: "人民币成本为按生效单价计算的估算值，供应商最终账单是最终费用依据。",
    };
  });

  app.get("/api/admin/agent-runtime", async (request, reply) => {
    const viewedAt = now();
    const actor = await superAdminForRequest(request, db, viewedAt);
    if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
    await recordAdministrationAudit(db, {
      actorMemberId: actor.id,
      action: "agent_runtime_viewed",
      createdAt: viewedAt,
    });
    const definitions = [
      agentEngine.interviewerDefinition,
      agentEngine.extractorDefinition,
      agentEngine.twinDefinition,
      agentEngine.matchingDefinition,
    ].map((definition) => ({
      role: definition.role,
      task: definition.task,
      definitionVersion: definition.version,
      promptVersion: definition.promptVersion,
      schemaVersion: definition.schemaVersion,
      primaryModel: definition.primaryModel,
      backupModel: definition.backupModel,
      systemPrompt: definition.systemPrompt,
      ...(definition.role === "match_evaluator"
        ? { promptFile: definition.promptFile }
        : {}),
    }));
    return {
      definitions,
      provider: agentModel?.provider ?? null,
      pricing:
        agentModel?.provider === "volcengine-ark" ? agentModel.pricing : null,
      updatePolicy: "Prompt、规则和模型版本只读展示，只能通过代码评审和 benchmark 更新。",
    };
  });

  app.get("/api/admin/audits", async (request, reply) => {
    const viewedAt = now();
    const actor = await superAdminForRequest(request, db, viewedAt);
    if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
    await recordAdministrationAudit(db, {
      actorMemberId: actor.id,
      action: "audit_log_viewed",
      createdAt: viewedAt,
    });
    const [administration, matching, quotas, deletion, moderation] =
      await Promise.all([
        db.select().from(administrationAudits),
        db.select().from(matchingSettingsAudits),
        db.select().from(agentQuotaSettingsAudits),
        db.select().from(memberDeletionAudits),
        db.select().from(moderationCaseAccessAudits),
      ]);
    const audits = [
      ...administration.map((audit) => ({
        id: audit.id,
        source: "administration",
        actorMemberId: audit.actorMemberId,
        targetMemberId: audit.targetMemberId,
        action: audit.action,
        resourceId: audit.resourceId,
        details: audit.details,
        createdAt: audit.createdAt,
      })),
      ...matching.map((audit) => ({
        id: audit.id,
        source: "matching_settings",
        actorMemberId: audit.actorId,
        targetMemberId: null,
        action: "matching_settings_updated",
        resourceId: null,
        details: {
          candidateCapacity: audit.candidateCapacity,
          minimumReciprocalScore: audit.minimumReciprocalScore,
        },
        createdAt: audit.createdAt,
      })),
      ...quotas.map((audit) => ({
        id: audit.id,
        source: "agent_quota_settings",
        actorMemberId: audit.actorId,
        targetMemberId: null,
        action: "agent_quota_settings_updated",
        resourceId: null,
        details: {
          ownAgentDailyLimit: audit.ownAgentDailyLimit,
          candidateTwinDailyLimit: audit.candidateTwinDailyLimit,
        },
        createdAt: audit.createdAt,
      })),
      ...deletion.map((audit) => ({
        id: audit.id,
        source: "member_lifecycle",
        actorMemberId: audit.actorMemberId,
        targetMemberId: audit.targetMemberId,
        action: `member_${audit.action}`,
        resourceId: null,
        details: {},
        createdAt: audit.createdAt,
      })),
      ...moderation.map((audit) => ({
        id: audit.id,
        source: "moderation",
        actorMemberId: audit.actorMemberId,
        targetMemberId: null,
        action: "moderation_case_viewed",
        resourceId: audit.caseId,
        details: {},
        createdAt: audit.createdAt,
      })),
    ].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    return { audits };
  });
}
