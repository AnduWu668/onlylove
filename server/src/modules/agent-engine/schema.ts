import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  conversationMessages,
  conversations,
} from "../conversations/schema.js";
import { members } from "../members/schema.js";

export type AgentJobStatus = "pending" | "running" | "completed" | "failed";
export type AgentRole =
  | "portrait_interviewer"
  | "portrait_extractor"
  | "public_twin"
  | "match_evaluator";
export type AgentTask =
  | "continue_interview"
  | "extract_portrait"
  | "reply_as_twin"
  | "evaluate_pair";

export const agentJobs = pgTable(
  "agent_jobs",
  {
    id: uuid("id").primaryKey(),
    role: varchar("role", { length: 40 })
      .$type<AgentRole>()
      .notNull(),
    task: varchar("task", { length: 40 })
      .$type<AgentTask>()
      .notNull(),
    definitionVersion: varchar("definition_version", { length: 80 }).notNull(),
    promptVersion: varchar("prompt_version", { length: 80 }).notNull(),
    schemaVersion: varchar("schema_version", { length: 80 }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    inputMessageId: uuid("input_message_id")
      .notNull()
      .references(() => conversationMessages.id),
    profileVersionId: uuid("profile_version_id"),
    calibrationScenarioId: uuid("calibration_scenario_id"),
    outputMessageId: uuid("output_message_id").references(
      () => conversationMessages.id,
    ),
    status: varchar("status", { length: 16 })
      .$type<AgentJobStatus>()
      .notNull(),
    retryCount: integer("retry_count").notNull(),
    switchedModel: boolean("switched_model").notNull(),
    quotaRefunded: boolean("quota_refunded").notNull(),
    error: varchar("error", { length: 80 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("agent_jobs_member_index").on(table.memberId),
    index("agent_jobs_status_index").on(table.status),
  ],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => agentJobs.id),
    role: varchar("role", { length: 40 })
      .$type<AgentRole>()
      .notNull(),
    task: varchar("task", { length: 40 })
      .$type<AgentTask>()
      .notNull(),
    definitionVersion: varchar("definition_version", { length: 80 }).notNull(),
    promptVersion: varchar("prompt_version", { length: 80 }).notNull(),
    schemaVersion: varchar("schema_version", { length: 80 }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    provider: varchar("provider", { length: 80 }).notNull(),
    requestedModel: varchar("requested_model", { length: 160 }).notNull(),
    actualModel: varchar("actual_model", { length: 160 }).notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    retryCount: integer("retry_count").notNull(),
    switchedModel: boolean("switched_model").notNull(),
    error: varchar("error", { length: 80 }),
    estimatedCostMicroCny: integer("estimated_cost_micro_cny").notNull(),
    inputCostCnyPerMillionTokens: doublePrecision(
      "input_cost_cny_per_million_tokens",
    ),
    outputCostCnyPerMillionTokens: doublePrecision(
      "output_cost_cny_per_million_tokens",
    ),
    pricingEffectiveDate: date("pricing_effective_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("agent_runs_job_index").on(table.jobId),
    uniqueIndex("agent_runs_job_task_retry_unique").on(
      table.jobId,
      table.task,
      table.retryCount,
    ),
  ],
);
