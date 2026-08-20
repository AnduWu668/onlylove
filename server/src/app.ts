import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { migrateDatabase, openDatabase } from "./db.js";
import {
  AgentEngine,
  type AgentModelOptions,
} from "./modules/agent-engine/engine.js";
import { AgentJobs } from "./modules/agent-engine/jobs.js";
import { registerConversationsRoutes } from "./modules/conversations/routes.js";
import type { Mailer } from "./modules/members/mailer.js";
import {
  bootstrapSuperAdmin,
  registerMembersRoutes,
} from "./modules/members/routes.js";
import { registerPortraitsRoutes } from "./modules/portraits/routes.js";
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
  const portraits = new Portraits(db, now);

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
  });
  registerPortraitsRoutes(app, { db, now, portraits });
  registerConversationsRoutes(app, {
    agentEngine,
    agentJobs,
    db,
    now,
    portraits,
  });
  app.addHook("onClose", async () => {
    agentEngine.close();
    await pool.end();
  });
  return app;
}
