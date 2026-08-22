import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { migrateDatabase, openDatabase } from "./db.js";
import {
  AgentEngine,
  type AgentModelOptions,
} from "./modules/agent-engine/engine.js";
import { AgentJobs } from "./modules/agent-engine/jobs.js";
import { MatchingConnections } from "./modules/connections/matching.js";
import { registerConversationsRoutes } from "./modules/conversations/routes.js";
import { InterviewConversations } from "./modules/conversations/interview.js";
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
  const matching = new Matching(
    db,
    now,
    agentJobs,
    agentEngine.matchingDefinition,
    new MatchingMembers(db),
    new MatchingPortraits(db),
    new MatchingModeration(db),
    new MatchingConnections(db),
  );

  await migrateDatabase(db);
  await bootstrapSuperAdmin(db, options.superAdminEmail, now());
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
    db,
    now,
    portraits,
  });
  registerMatchingRoutes(app, { db, now, matching });
  app.addHook("onClose", async () => {
    agentEngine.close();
    await pool.end();
  });
  return app;
}
