import { index, jsonb, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { members } from "../members/schema.js";

export type AdministrationAuditAction =
  | "administrator_created"
  | "administrator_activated"
  | "administrator_deactivated"
  | "administrator_directory_viewed"
  | "member_directory_viewed"
  | "member_sensitive_viewed"
  | "dashboard_viewed"
  | "agent_observability_viewed"
  | "agent_runtime_viewed"
  | "agent_runs_viewed"
  | "failed_agent_jobs_viewed"
  | "failed_agent_job_retried"
  | "failed_agent_job_assigned"
  | "audit_log_viewed";

export const administrationAudits = pgTable(
  "administration_audits",
  {
    id: uuid("id").primaryKey(),
    actorMemberId: uuid("actor_member_id")
      .notNull()
      .references(() => members.id),
    targetMemberId: uuid("target_member_id").references(() => members.id),
    action: varchar("action", { length: 48 })
      .$type<AdministrationAuditAction>()
      .notNull(),
    resourceId: uuid("resource_id"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("administration_audits_created_index").on(table.createdAt)],
);
