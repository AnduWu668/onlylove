import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { migrateDatabase, openDatabase } from "./db.js";
import {
  AgentEngine,
  type AgentModelOptions,
} from "./modules/agent-engine/engine.js";
import { AgentJobs } from "./modules/agent-engine/jobs.js";
import { MatchingConnections } from "./modules/connections/matching.js";
import { ModerationConnections } from "./modules/connections/moderation.js";
import { registerConnectionsRoutes } from "./modules/connections/routes.js";
import { Connections } from "./modules/connections/service.js";
import { ConnectionConversations } from "./modules/conversations/connections.js";
import { MemberConversations } from "./modules/conversations/members.js";
import { ModerationConversations } from "./modules/conversations/moderation.js";
import { registerConversationsRoutes } from "./modules/conversations/routes.js";
import { InterviewConversations } from "./modules/conversations/interview.js";
import { ConnectionMatching } from "./modules/matching/connections.js";
import { ModerationMatching } from "./modules/matching/moderation.js";
import { ConnectionMembers } from "./modules/members/connections.js";
import type { Mailer } from "./modules/members/mailer.js";
import {
  bootstrapSuperAdmin,
  registerMembersRoutes,
} from "./modules/members/routes.js";
import { MatchingMembers } from "./modules/members/matching.js";
import { ModerationMembers } from "./modules/members/moderation.js";
import { MatchingModeration } from "./modules/moderation/matching.js";
import { registerModerationRoutes } from "./modules/moderation/routes.js";
import { Moderation } from "./modules/moderation/service.js";
import { registerMatchingRoutes } from "./modules/matching/routes.js";
import { Matching } from "./modules/matching/service.js";
import { registerPortraitsRoutes } from "./modules/portraits/routes.js";
import { MatchingPortraits } from "./modules/portraits/matching.js";
import { ConnectionPortraits } from "./modules/portraits/connections.js";
import { Portraits } from "./modules/portraits/service.js";

export interface AppOptions {
  databaseUrl: string;
  mailer: Mailer;
  otpSecret: string;
  superAdminEmail: string;
  now?: () => Date;
  production?: boolean;
  agentModel?: AgentModelOptions;
  agentInputTokenBudget?: number;
  connectionMaintenanceIntervalMs?: number;
}

export async function createApp(options: AppOptions) {
  const app = Fastify({ logger: options.production ?? false });
  const { db, pool } = openDatabase(options.databaseUrl);
  const now = options.now ?? (() => new Date());
  const agentEngine = new AgentEngine(
    options.agentModel,
    options.agentInputTokenBudget,
  );
  const agentJobs = new AgentJobs(db);
  const interviewConversations = new InterviewConversations(db);
  const portraits = new Portraits(db, now, interviewConversations, agentJobs);
  const matchingModeration = new MatchingModeration(db);
  const moderationConnections = new ModerationConnections(db);
  const memberConversations = new MemberConversations(db);
  const connections = new Connections(
    db,
    now,
    options.mailer,
    new ConnectionConversations(db),
    new ConnectionMatching(db),
    new ConnectionMembers(db),
    matchingModeration,
    new ConnectionPortraits(db),
  );
  const matching = new Matching(
    db,
    now,
    agentJobs,
    agentEngine.matchingDefinition,
    new MatchingMembers(db),
    new MatchingPortraits(db),
    matchingModeration,
    new MatchingConnections(db),
  );
  const moderation = new Moderation(
    db,
    now,
    options.mailer,
    new ModerationConversations(db),
    moderationConnections,
    new ModerationMatching(db),
    new ModerationMembers(db),
  );

  await migrateDatabase(db);
  await bootstrapSuperAdmin(db, options.superAdminEmail, now());
  await connections.runMaintenance();
  await moderation.flushNotifications();
  await app.register(cookie);
  app.get("/api/health", async () => ({ status: "ok" }));
  registerMembersRoutes(app, {
    db,
    mailer: options.mailer,
    now,
    otpSecret: options.otpSecret,
    production: options.production ?? false,
    endMemberInteractions: (memberId, endedAt, transaction) =>
      moderationConnections.endForMember(memberId, endedAt, transaction),
    purgeMemberData: async (memberId, email, transaction) => {
      const conversationIds = await memberConversations.privateConversationIds(
        memberId,
        transaction,
      );
      await moderation.purgeMemberData(memberId, transaction);
      await connections.purgeMemberData(memberId, email, transaction);
      const matchingJobIds = await matching.purgeMemberData(
        memberId,
        transaction,
      );
      await agentJobs.purgeMemberData(
        memberId,
        conversationIds,
        matchingJobIds,
        transaction,
      );
      await portraits.purgeMemberData(memberId, transaction);
      await memberConversations.purgeMemberData(
        memberId,
        conversationIds,
        transaction,
      );
    },
    recheckRecommendations: (memberId) => matching.recheckForMember(memberId),
  });
  registerPortraitsRoutes(app, {
    agentEngine,
    agentJobs,
    db,
    now,
    portraits,
  });
  registerConversationsRoutes(app, {
    agentEngine,
    agentJobs,
    candidateForTwinConversation: (
      memberId,
      recommendationId,
      candidateId,
      transaction,
    ) =>
      matching.candidateForTwinConversation(
        memberId,
        recommendationId,
        candidateId,
        transaction,
      ),
    requesterForTwinConversation: (
      memberId,
      contactRequestId,
      requesterMemberId,
      transaction,
    ) =>
      connections.requesterForTwinConversation(
        memberId,
        contactRequestId,
        requesterMemberId,
        transaction,
      ),
    humanConversationAccess: (memberId, connectionId, database) =>
      connections.humanConversationAccess(memberId, connectionId, database),
    completeConnectionReview: (memberId, completedAt) =>
      connections.completeReview(memberId, completedAt),
    db,
    now,
    portraits,
  });
  registerConnectionsRoutes(app, { connections, db, now });
  registerMatchingRoutes(app, { db, now, matching });
  registerModerationRoutes(app, { db, moderation, now });
  const connectionMaintenance = setInterval(() => {
    void connections.runMaintenance().catch((error) => app.log.error(error));
  }, options.connectionMaintenanceIntervalMs ?? 60_000);
  connectionMaintenance.unref();
  app.addHook("onClose", async () => {
    clearInterval(connectionMaintenance);
    agentEngine.close();
    await pool.end();
  });
  return app;
}
