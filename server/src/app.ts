import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { migrateDatabase, openDatabase } from "./db.js";
import type { Mailer } from "./modules/members/mailer.js";
import {
  bootstrapSuperAdmin,
  registerMembersRoutes,
} from "./modules/members/routes.js";

export interface AppOptions {
  databaseUrl: string;
  mailer: Mailer;
  otpSecret: string;
  superAdminEmail: string;
  now?: () => Date;
  production?: boolean;
}

export async function createApp(options: AppOptions) {
  const app = Fastify({ logger: options.production ?? false });
  const { db, pool } = openDatabase(options.databaseUrl);
  const now = options.now ?? (() => new Date());

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
  app.addHook("onClose", async () => pool.end());
  return app;
}
