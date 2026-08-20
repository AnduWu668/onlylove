import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
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
