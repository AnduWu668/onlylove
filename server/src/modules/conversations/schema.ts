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
    profileVersionId: uuid("profile_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("conversations_member_type_unique").on(
      table.memberId,
      table.type,
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
