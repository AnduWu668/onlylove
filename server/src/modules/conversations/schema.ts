import { sql } from "drizzle-orm";
import {
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  text,
} from "drizzle-orm/pg-core";
import { memberConnections } from "../connections/schema.js";
import { members } from "../members/schema.js";

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey(),
    type: varchar("type", { length: 16 })
      .$type<"INTERVIEW" | "TWIN" | "HUMAN">()
      .notNull(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    visitorMemberId: uuid("visitor_member_id").references(() => members.id),
    recommendationId: uuid("recommendation_id"),
    contactRequestId: uuid("contact_request_id"),
    connectionId: uuid("connection_id").references(() => memberConnections.id),
    anonymousCode: varchar("anonymous_code", { length: 16 }),
    visibilityConsentAt: timestamp("visibility_consent_at", {
      withTimezone: true,
    }),
    profileVersionId: uuid("profile_version_id"),
    memberLastReadSequence: integer("member_last_read_sequence")
      .default(0)
      .notNull(),
    visitorLastReadSequence: integer("visitor_last_read_sequence")
      .default(0)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("conversations_member_type_unique")
      .on(table.memberId, table.type)
      .where(sql`${table.visitorMemberId} is null`),
    uniqueIndex("conversations_visitor_recommendation_unique")
      .on(table.visitorMemberId, table.recommendationId)
      .where(sql`${table.visitorMemberId} is not null`),
    uniqueIndex("conversations_visitor_contact_request_unique")
      .on(table.visitorMemberId, table.contactRequestId)
      .where(sql`${table.contactRequestId} is not null`),
    uniqueIndex("conversations_connection_unique")
      .on(table.connectionId)
      .where(sql`${table.connectionId} is not null`),
    uniqueIndex("conversations_anonymous_code_unique").on(table.anonymousCode),
    index("conversations_owner_visitor_index").on(
      table.memberId,
      table.visitorMemberId,
    ),
  ],
);

export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    role: varchar("role", { length: 16 })
      .$type<"member" | "agent">()
      .notNull(),
    content: text("content").notNull(),
    sequence: integer("sequence").notNull(),
    clientMessageId: uuid("client_message_id"),
    senderMemberId: uuid("sender_member_id").references(() => members.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("conversation_messages_sequence_unique").on(
      table.conversationId,
      table.sequence,
    ),
    uniqueIndex("conversation_messages_client_id_unique").on(
      table.conversationId,
      table.clientMessageId,
    ),
    index("conversation_messages_conversation_index").on(table.conversationId),
  ],
);

export const ownAgentDailyQuotas = pgTable(
  "own_agent_daily_quotas",
  {
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    quotaDate: date("quota_date").notNull(),
    used: integer("used").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.memberId, table.quotaDate] })],
);

export const candidateTwinDailyQuotas = pgTable(
  "candidate_twin_daily_quotas",
  {
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    quotaDate: date("quota_date").notNull(),
    used: integer("used").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.memberId, table.quotaDate] })],
);

export const agentQuotaSettings = pgTable("agent_quota_settings", {
  id: integer("id").primaryKey(),
  ownAgentDailyLimit: integer("own_agent_daily_limit").notNull(),
  candidateTwinDailyLimit: integer("candidate_twin_daily_limit").notNull(),
  updatedBy: uuid("updated_by").references(() => members.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const agentQuotaSettingsAudits = pgTable(
  "agent_quota_settings_audits",
  {
    id: uuid("id").primaryKey(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => members.id),
    previousOwnAgentDailyLimit: integer(
      "previous_own_agent_daily_limit",
    ).notNull(),
    previousCandidateTwinDailyLimit: integer(
      "previous_candidate_twin_daily_limit",
    ).notNull(),
    ownAgentDailyLimit: integer("own_agent_daily_limit").notNull(),
    candidateTwinDailyLimit: integer("candidate_twin_daily_limit").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("agent_quota_settings_audits_created_index").on(table.createdAt),
  ],
);
