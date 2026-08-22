import { sql } from "drizzle-orm";
import {
  index,
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

export type ModerationTargetKind =
  | "recommendation"
  | "contact_request"
  | "connection"
  | "twin_message"
  | "human_message";
export type ModerationAction =
  | "dismissed"
  | "warning"
  | "suspended"
  | "banned";

export const memberBlocks = pgTable(
  "member_blocks",
  {
    blockerMemberId: uuid("blocker_member_id")
      .notNull()
      .references(() => members.id),
    blockedMemberId: uuid("blocked_member_id")
      .notNull()
      .references(() => members.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blockerMemberId, table.blockedMemberId] }),
  ],
);

export const distortionFeedback = pgTable(
  "distortion_feedback",
  {
    id: uuid("id").primaryKey(),
    reporterMemberId: uuid("reporter_member_id")
      .notNull()
      .references(() => members.id),
    twinOwnerMemberId: uuid("twin_owner_member_id")
      .notNull()
      .references(() => members.id),
    messageId: uuid("message_id")
      .notNull()
      .references(() => conversationMessages.id),
    details: text("details").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("distortion_feedback_reporter_message_unique").on(
      table.reporterMemberId,
      table.messageId,
    ),
    index("distortion_feedback_owner_index").on(table.twinOwnerMemberId),
  ],
);

export const moderationCases = pgTable(
  "moderation_cases",
  {
    id: uuid("id").primaryKey(),
    type: varchar("type", { length: 16 })
      .$type<"report" | "appeal">()
      .notNull(),
    reporterMemberId: uuid("reporter_member_id")
      .notNull()
      .references(() => members.id),
    reportedMemberId: uuid("reported_member_id")
      .notNull()
      .references(() => members.id),
    targetKind: varchar("target_kind", { length: 24 })
      .$type<ModerationTargetKind>()
      .notNull(),
    targetId: uuid("target_id").notNull(),
    messageId: uuid("message_id").references(() => conversationMessages.id),
    conversationId: uuid("conversation_id"),
    reason: text("reason").notNull(),
    evidence: text("evidence").notNull(),
    status: varchar("status", { length: 16 })
      .$type<"pending" | "resolved">()
      .notNull(),
    originalCaseId: uuid("original_case_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("moderation_cases_status_index").on(table.status, table.createdAt),
    index("moderation_cases_reporter_index").on(table.reporterMemberId),
    index("moderation_cases_reported_index").on(table.reportedMemberId),
    uniqueIndex("moderation_cases_original_case_unique")
      .on(table.originalCaseId)
      .where(sql`${table.originalCaseId} is not null`),
  ],
);

export const moderationDecisions = pgTable(
  "moderation_decisions",
  {
    caseId: uuid("case_id")
      .primaryKey()
      .references(() => moderationCases.id),
    decidedByMemberId: uuid("decided_by_member_id")
      .notNull()
      .references(() => members.id),
    action: varchar("action", { length: 16 })
      .$type<ModerationAction>()
      .notNull(),
    reason: text("reason").notNull(),
    suspendedUntil: timestamp("suspended_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
);

export const moderationCaseAccessAudits = pgTable(
  "moderation_case_access_audits",
  {
    id: uuid("id").primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => moderationCases.id),
    actorMemberId: uuid("actor_member_id")
      .notNull()
      .references(() => members.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("moderation_case_access_audits_case_index").on(table.caseId),
  ],
);

export const memberRecommendationRestrictions = pgTable(
  "member_recommendation_restrictions",
  {
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    sourceCaseId: uuid("source_case_id")
      .notNull()
      .references(() => moderationCases.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.memberId, table.sourceCaseId] })],
);

export const moderationNotificationOutbox = pgTable(
  "moderation_notification_outbox",
  {
    id: uuid("id").primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => moderationCases.id),
    recipientMemberId: uuid("recipient_member_id")
      .notNull()
      .references(() => members.id),
    email: varchar("email", { length: 320 }).notNull(),
    disclosure: varchar("disclosure", { length: 16 })
      .$type<"reporter" | "reported">()
      .notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("moderation_notification_case_disclosure_unique").on(
      table.caseId,
      table.disclosure,
    ),
    index("moderation_notification_unsent_index").on(table.sentAt),
  ],
);
