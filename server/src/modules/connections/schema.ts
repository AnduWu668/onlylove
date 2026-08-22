import {
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { candidateRecommendations } from "../matching/schema.js";
import { members } from "../members/schema.js";

export const memberConnections = pgTable(
  "member_connections",
  {
    id: uuid("id").primaryKey(),
    memberAId: uuid("member_a_id")
      .notNull()
      .references(() => members.id),
    memberBId: uuid("member_b_id")
      .notNull()
      .references(() => members.id),
    status: varchar("status", { length: 16 })
      .$type<"active" | "ended">()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [index("member_connections_status_index").on(table.status)],
);

export const currentConnectionMembers = pgTable(
  "current_connection_members",
  {
    memberId: uuid("member_id")
      .primaryKey()
      .references(() => members.id),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => memberConnections.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("current_connection_members_connection_index").on(
      table.connectionId,
    ),
  ],
);

export type ContactRequestStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "expired"
  | "cancelled";

export const contactRequests = pgTable(
  "contact_requests",
  {
    id: uuid("id").primaryKey(),
    recommendationId: uuid("recommendation_id")
      .notNull()
      .references(() => candidateRecommendations.id),
    requesterMemberId: uuid("requester_member_id")
      .notNull()
      .references(() => members.id),
    recipientMemberId: uuid("recipient_member_id")
      .notNull()
      .references(() => members.id),
    status: varchar("status", { length: 16 })
      .$type<ContactRequestStatus>()
      .notNull(),
    connectionId: uuid("connection_id").references(() => memberConnections.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("contact_requests_recommendation_unique").on(
      table.recommendationId,
    ),
    index("contact_requests_recipient_status_index").on(
      table.recipientMemberId,
      table.status,
    ),
    index("contact_requests_requester_status_index").on(
      table.requesterMemberId,
      table.status,
    ),
  ],
);

export const contactNotificationOutbox = pgTable(
  "contact_notification_outbox",
  {
    id: uuid("id").primaryKey(),
    contactRequestId: uuid("contact_request_id")
      .notNull()
      .references(() => contactRequests.id),
    type: varchar("type", { length: 24 })
      .$type<"contact_request" | "contact_accepted">()
      .notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    nickname: varchar("nickname", { length: 120 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("contact_notification_outbox_event_unique").on(
      table.contactRequestId,
      table.type,
      table.email,
    ),
    index("contact_notification_outbox_sent_index").on(table.sentAt),
  ],
);
