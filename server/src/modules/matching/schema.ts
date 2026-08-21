import {
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { agentJobs } from "../agent-engine/schema.js";
import { members, matchCriteriaVersions } from "../members/schema.js";
import { portraitVersions } from "../portraits/schema.js";
import type { PairEvaluationInput, PairEvaluationResult } from "./evaluation.js";

export const matchingSettings = pgTable("matching_settings", {
  id: integer("id").primaryKey(),
  candidateCapacity: integer("candidate_capacity").notNull(),
  minimumReciprocalScore: doublePrecision("minimum_reciprocal_score").notNull(),
  updatedBy: uuid("updated_by").references(() => members.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const matchingSettingsAudits = pgTable(
  "matching_settings_audits",
  {
    id: uuid("id").primaryKey(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => members.id),
    previousCapacity: integer("previous_capacity").notNull(),
    previousMinimumScore: doublePrecision("previous_minimum_score").notNull(),
    candidateCapacity: integer("candidate_capacity").notNull(),
    minimumReciprocalScore: doublePrecision("minimum_reciprocal_score").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("matching_settings_audits_created_index").on(table.createdAt)],
);

export const pairEvaluations = pgTable(
  "pair_evaluations",
  {
    id: uuid("id").primaryKey(),
    memberAId: uuid("member_a_id")
      .notNull()
      .references(() => members.id),
    memberBId: uuid("member_b_id")
      .notNull()
      .references(() => members.id),
    portraitVersionAId: uuid("portrait_version_a_id")
      .notNull()
      .references(() => portraitVersions.id),
    portraitVersionBId: uuid("portrait_version_b_id")
      .notNull()
      .references(() => portraitVersions.id),
    criteriaVersionAId: uuid("criteria_version_a_id")
      .notNull()
      .references(() => matchCriteriaVersions.id),
    criteriaVersionBId: uuid("criteria_version_b_id")
      .notNull()
      .references(() => matchCriteriaVersions.id),
    agentJobId: uuid("agent_job_id")
      .notNull()
      .references(() => agentJobs.id),
    rubricVersion: varchar("rubric_version", { length: 80 }).notNull(),
    result: jsonb("result").$type<PairEvaluationResult>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("pair_evaluations_versions_unique").on(
      table.memberAId,
      table.memberBId,
      table.portraitVersionAId,
      table.portraitVersionBId,
      table.criteriaVersionAId,
      table.criteriaVersionBId,
      table.rubricVersion,
    ),
    uniqueIndex("pair_evaluations_agent_job_unique").on(table.agentJobId),
  ],
);

export type CandidateRecommendationStatus =
  | "pending"
  | "rechecking"
  | "skipped"
  | "removed";

export const candidateRecommendations = pgTable(
  "candidate_recommendations",
  {
    id: uuid("id").primaryKey(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    candidateMemberId: uuid("candidate_member_id")
      .notNull()
      .references(() => members.id),
    pairEvaluationId: uuid("pair_evaluation_id")
      .notNull()
      .references(() => pairEvaluations.id),
    memberPortraitVersionId: uuid("member_portrait_version_id")
      .notNull()
      .references(() => portraitVersions.id),
    candidatePortraitVersionId: uuid("candidate_portrait_version_id")
      .notNull()
      .references(() => portraitVersions.id),
    memberCriteriaVersionId: uuid("member_criteria_version_id")
      .notNull()
      .references(() => matchCriteriaVersions.id),
    candidateCriteriaVersionId: uuid("candidate_criteria_version_id")
      .notNull()
      .references(() => matchCriteriaVersions.id),
    reason: text("reason").notNull(),
    status: varchar("status", { length: 16 })
      .$type<CandidateRecommendationStatus>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("candidate_recommendations_versions_unique").on(
      table.memberId,
      table.candidateMemberId,
      table.memberPortraitVersionId,
      table.candidatePortraitVersionId,
      table.memberCriteriaVersionId,
      table.candidateCriteriaVersionId,
    ),
    index("candidate_recommendations_member_status_index").on(
      table.memberId,
      table.status,
    ),
  ],
);

export const recommendationDailyRuns = pgTable(
  "recommendation_daily_runs",
  {
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    runDate: date("run_date").notNull(),
    status: varchar("status", { length: 16 })
      .$type<"running" | "completed" | "failed">()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.memberId, table.runDate] })],
);

export const matchingFollowupQuestions = pgTable(
  "matching_followup_questions",
  {
    id: uuid("id").primaryKey(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    pairEvaluationId: uuid("pair_evaluation_id")
      .notNull()
      .references(() => pairEvaluations.id),
    questionKey: varchar("question_key", { length: 80 }).notNull(),
    question: text("question").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("matching_followup_member_evaluation_key_unique").on(
      table.memberId,
      table.pairEvaluationId,
      table.questionKey,
    ),
  ],
);

export const recommendationPairJobs = pgTable(
  "recommendation_pair_jobs",
  {
    id: uuid("id").primaryKey(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    candidateMemberId: uuid("candidate_member_id")
      .notNull()
      .references(() => members.id),
    runDate: date("run_date"),
    recommendationId: uuid("recommendation_id").references(
      () => candidateRecommendations.id,
    ),
    agentJobId: uuid("agent_job_id").references(() => agentJobs.id),
    pairEvaluationId: uuid("pair_evaluation_id").references(
      () => pairEvaluations.id,
    ),
    memberPortraitVersionId: uuid("member_portrait_version_id")
      .notNull()
      .references(() => portraitVersions.id),
    candidatePortraitVersionId: uuid("candidate_portrait_version_id")
      .notNull()
      .references(() => portraitVersions.id),
    memberCriteriaVersionId: uuid("member_criteria_version_id")
      .notNull()
      .references(() => matchCriteriaVersions.id),
    candidateCriteriaVersionId: uuid("candidate_criteria_version_id")
      .notNull()
      .references(() => matchCriteriaVersions.id),
    input: jsonb("input").$type<PairEvaluationInput>().notNull(),
    status: varchar("status", { length: 16 })
      .$type<"pending" | "completed" | "failed">()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("recommendation_pair_jobs_agent_job_unique").on(table.agentJobId),
    index("recommendation_pair_jobs_run_index").on(
      table.memberId,
      table.runDate,
      table.status,
    ),
    index("recommendation_pair_jobs_recommendation_index").on(
      table.recommendationId,
      table.status,
    ),
  ],
);
