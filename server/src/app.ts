import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { migrateDatabase, openDatabase } from "./db.js";
import {
  AgentEngine,
  type AgentModelOptions,
} from "./modules/agent-engine/engine.js";
import { AgentJobs } from "./modules/agent-engine/jobs.js";
import { MatchingConnections } from "./modules/connections/matching.js";
import { registerConnectionsRoutes } from "./modules/connections/routes.js";
import { Connections } from "./modules/connections/service.js";
import { ConnectionConversations } from "./modules/conversations/connections.js";
import { registerConversationsRoutes } from "./modules/conversations/routes.js";
import { InterviewConversations } from "./modules/conversations/interview.js";
import { ConnectionMatching } from "./modules/matching/connections.js";
import { ConnectionMembers } from "./modules/members/connections.js";
import type { Mailer } from "./modules/members/mailer.js";
import {
  bootstrapSuperAdmin,
  registerMembersRoutes,
} from "./modules/members/routes.js";
import { MatchingMembers } from "./modules/members/matching.js";
import { MatchingModeration } from "./modules/moderation/matching.js";
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

  await migrateDatabase(db);
  await bootstrapSuperAdmin(db, options.superAdminEmail, now());
  await connections.runMaintenance();
  await app.register(cookie);
  app.get("/api/health", async () => ({ status: "ok" }));
  registerMembersRoutes(app, {
    db,
    mailer: options.mailer,
    now,
    otpSecret: options.otpSecret,
    production: options.production ?? false,
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
    db,
    now,
    portraits,
  });
  registerConnectionsRoutes(app, { connections, db, now });
  registerMatchingRoutes(app, { db, now, matching });
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
