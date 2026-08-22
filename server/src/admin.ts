import type { FastifyInstance } from "fastify";
import type { Database } from "./db.js";
import type {
  AgentEngine,
  AgentModelOptions,
} from "./modules/agent-engine/engine.js";
import type { AgentJobs } from "./modules/agent-engine/jobs.js";
import type { Connections } from "./modules/connections/service.js";
import type { MemberConversations } from "./modules/conversations/members.js";
import type { Matching } from "./modules/matching/service.js";
import type { MembersAdministration } from "./modules/members/administration.js";
import { superAdminForRequest } from "./modules/members/routes.js";
import type { members } from "./modules/members/schema.js";
import type { Moderation } from "./modules/moderation/service.js";
import type { Portraits } from "./modules/portraits/service.js";

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
    agentJobs: AgentJobs;
    agentModel?: AgentModelOptions;
    connections: Connections;
    conversations: MemberConversations;
    matching: Matching;
    members: MembersAdministration;
    moderation: Moderation;
    portraits: Portraits;
  },
) {
  const {
    db,
    now,
    agentEngine,
    agentJobs,
    agentModel,
    connections,
    conversations,
    matching,
    members,
    moderation,
    portraits,
  } = options;

  app.get("/api/admin/administrators", async (request, reply) => {
    const viewedAt = now();
    const actor = await superAdminForRequest(request, db, viewedAt);
    if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
    const rows = await members.administrators();
    await members.recordAudit({
      actorMemberId: actor.id,
      action: "administrator_directory_viewed",
      createdAt: viewedAt,
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
      const created = await members.createAdministrator(
        request.body.email,
        actor.id,
        createdAt,
      );
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
      const administrator = await members.setAdministratorActive(
        request.params.id,
        request.body.active,
        actor.id,
        changedAt,
      );
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
    const directory = await members.memberDirectory();
    await members.recordAudit({
      actorMemberId: actor.id,
      action: "member_directory_viewed",
      createdAt: viewedAt,
    });
    return { members: directory };
  });

  app.get<{ Params: { id: string } }>(
    "/api/admin/members/:id",
    { schema: { params: uuidParams } },
    async (request, reply) => {
      const viewedAt = now();
      const actor = await superAdminForRequest(request, db, viewedAt);
      if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
      const member = await members.memberDetail(request.params.id);
      if (!member) return reply.code(404).send({ code: "MEMBER_NOT_FOUND" });
      const [portrait, pairEvaluations] = await Promise.all([
        portraits.administrationDetail(request.params.id),
        matching.administrationMemberEvaluations(request.params.id),
      ]);
      const conversation = await conversations.administrationDetail(
        request.params.id,
        portrait.evidenceMessageIds,
      );
      await members.recordAudit({
        actorMemberId: actor.id,
        targetMemberId: request.params.id,
        action: "member_sensitive_viewed",
        createdAt: viewedAt,
      });
      return {
        ...member,
        portrait: portrait.portrait,
        portraitVersions: portrait.portraitVersions,
        ...conversation,
        pairEvaluations,
      };
    },
  );

  app.get("/api/admin/dashboard", async (request, reply) => {
    const viewedAt = now();
    const actor = await superAdminForRequest(request, db, viewedAt);
    if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
    // ponytail: live full-table metrics fit the MVP; add rollups when admin latency grows.
    const [memberMetrics, portraitMetrics, recommendations, contacts, quality] =
      await Promise.all([
        members.metrics(viewedAt),
        portraits.administrationMetrics(),
        matching.administrationMetrics(),
        connections.administrationMetrics(),
        moderation.metrics(),
      ]);
    const memberReady = new Set(memberMetrics.recommendationReadyMemberIds);
    await members.recordAudit({
      actorMemberId: actor.id,
      action: "dashboard_viewed",
      createdAt: viewedAt,
    });
    return {
      members: {
        registered: memberMetrics.registered,
        profileCompleted: memberMetrics.profileCompleted,
        structuredCriteriaCompleted: memberMetrics.structuredCriteriaCompleted,
        portraitStarted: portraitMetrics.portraitStarted,
        portraitComplete: portraitMetrics.portraitComplete,
        submitted: portraitMetrics.submitted,
        calibrationPassed: portraitMetrics.calibrationPassed,
        published: portraitMetrics.published,
        recommendationEligible: portraitMetrics.publishedPassingMemberIds.filter(
          (id) => memberReady.has(id),
        ).length,
      },
      recommendations,
      contacts,
      quality: {
        calibrationPassRate: portraitMetrics.calibrationPassRate,
        criticalFabrications: portraitMetrics.criticalFabrications,
        distortionFeedback: quality.distortionFeedbackCount,
      },
    };
  });

  app.get("/api/admin/agent-observability", async (request, reply) => {
    const viewedAt = now();
    const actor = await superAdminForRequest(request, db, viewedAt);
    if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
    const observability = await agentJobs.observability();
    await members.recordAudit({
      actorMemberId: actor.id,
      action: "agent_observability_viewed",
      createdAt: viewedAt,
    });
    return observability;
  });

  app.get("/api/admin/agent-runtime", async (request, reply) => {
    const viewedAt = now();
    const actor = await superAdminForRequest(request, db, viewedAt);
    if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
    await members.recordAudit({
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
      updatePolicy:
        "Prompt、规则和模型版本只读展示，只能通过代码评审和 benchmark 更新。",
    };
  });

  app.get("/api/admin/audits", async (request, reply) => {
    const viewedAt = now();
    const actor = await superAdminForRequest(request, db, viewedAt);
    if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
    await members.recordAudit({
      actorMemberId: actor.id,
      action: "audit_log_viewed",
      createdAt: viewedAt,
    });
    const [administration, matchingSettings, agentQuotaSettings] =
      await Promise.all([
        members.audits(),
        matching.settingsAudit(),
        conversations.agentQuotaSettingsAudit(),
      ]);
    return {
      audits: [
        ...administration,
        ...matchingSettings.map((audit) => ({
          id: audit.id,
          actorMemberId: audit.actorId,
          targetMemberId: null,
          action: "matching_settings_updated",
          details: {
            candidateCapacity: audit.candidateCapacity,
            minimumReciprocalScore: audit.minimumReciprocalScore,
          },
          createdAt: audit.createdAt,
        })),
        ...agentQuotaSettings.map((audit) => ({
          id: audit.id,
          actorMemberId: audit.actorId,
          targetMemberId: null,
          action: "agent_quota_settings_updated",
          details: {
            ownAgentDailyLimit: audit.ownAgentDailyLimit,
            candidateTwinDailyLimit: audit.candidateTwinDailyLimit,
          },
          createdAt: audit.createdAt,
        })),
      ].sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime(),
      ),
    };
  });
}
