import {
  boolean,
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
import { conversationMessages } from "../conversations/schema.js";
import { members } from "../members/schema.js";
import type { PortraitDimension } from "./questions.js";

export type PortraitConfidence = "low" | "medium" | "high";

export interface PortraitDimensionDraft {
  selfTendency: string | null;
  partnerExpectation: string | null;
  hardBoundary: string | null;
  importance: number | null;
  confidence: PortraitConfidence;
  evidenceMessageIds: string[];
  contradictions: string[];
}

export type PortraitDraftContent = Record<
  PortraitDimension,
  PortraitDimensionDraft
>;

export interface MatchProfile {
  schemaVersion: string;
  dimensions: PortraitDraftContent;
}

export const portraitFixedAnswers = pgTable(
  "portrait_fixed_answers",
  {
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    questionId: varchar("question_id", { length: 80 }).notNull(),
    selectedOptionIds: varchar("selected_option_ids", { length: 80 })
      .array()
      .notNull(),
    noneApplies: boolean("none_applies").notNull(),
    freeText: text("free_text").notNull(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => conversationMessages.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.memberId, table.questionId] }),
    index("portrait_fixed_answers_member_index").on(table.memberId),
  ],
);

export const portraitDrafts = pgTable("portrait_drafts", {
  memberId: uuid("member_id")
    .primaryKey()
    .references(() => members.id),
  schemaVersion: varchar("schema_version", { length: 80 }).notNull(),
  plannerVersion: varchar("planner_version", { length: 80 }).notNull(),
  content: jsonb("content").$type<PortraitDraftContent>().notNull(),
  completedDimensions: integer("completed_dimensions").notNull(),
  lastMessageSequence: integer("last_message_sequence").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const portraitVersions = pgTable(
  "portrait_versions",
  {
    id: uuid("id").primaryKey(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    version: integer("version").notNull(),
    clientRequestId: uuid("client_request_id").notNull(),
    sourceDraftSchemaVersion: varchar("source_draft_schema_version", {
      length: 80,
    }).notNull(),
    matchProfile: jsonb("match_profile").$type<MatchProfile>().notNull(),
    personaContextSchemaVersion: varchar("persona_context_schema_version", {
      length: 80,
    }).notNull(),
    personaContext: text("persona_context").notNull(),
    calibrationSchemaVersion: varchar("calibration_schema_version", {
      length: 80,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("portrait_versions_member_version_unique").on(
      table.memberId,
      table.version,
    ),
    uniqueIndex("portrait_versions_member_request_unique").on(
      table.memberId,
      table.clientRequestId,
    ),
  ],
);

export const portraitCalibrationScenarios = pgTable(
  "portrait_calibration_scenarios",
  {
    id: uuid("id").primaryKey(),
    portraitVersionId: uuid("portrait_version_id")
      .notNull()
      .references(() => portraitVersions.id),
    position: integer("position").notNull(),
    dimensions: varchar("dimensions", { length: 40 }).array().notNull(),
    prompt: text("prompt").notNull(),
    prediction: text("prediction"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("portrait_calibration_version_position_unique").on(
      table.portraitVersionId,
      table.position,
    ),
  ],
);

export type CalibrationRating = "like" | "partial" | "unlike";

export const portraitCalibrationAnswers = pgTable(
  "portrait_calibration_answers",
  {
    scenarioId: uuid("scenario_id")
      .primaryKey()
      .references(() => portraitCalibrationScenarios.id),
    rating: varchar("rating", { length: 16 })
      .$type<CalibrationRating>()
      .notNull(),
    correction: text("correction").notNull(),
    criticalFabrication: boolean("critical_fabrication").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
);

export const portraitMemberStates = pgTable("portrait_member_states", {
  memberId: uuid("member_id")
    .primaryKey()
    .references(() => members.id),
  submittedVersionId: uuid("submitted_version_id")
    .notNull()
    .references(() => portraitVersions.id),
  publishedVersionId: uuid("published_version_id").references(
    () => portraitVersions.id,
  ),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});
