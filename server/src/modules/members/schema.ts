import {
  date,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export type MemberRole = "member" | "admin" | "super_admin";

export const members = pgTable(
  "members",
  {
    id: uuid("id").primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    role: varchar("role", { length: 32 }).$type<MemberRole>().notNull(),
    birthDate: date("birth_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("members_email_unique").on(table.email)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    issuedBy: uuid("issued_by")
      .notNull()
      .references(() => members.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (table) => [index("invitations_email_index").on(table.email)],
);

export const otpChallenges = pgTable(
  "otp_challenges",
  {
    id: uuid("id").primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resendAt: timestamp("resend_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [index("otp_challenges_email_index").on(table.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_member_index").on(table.memberId),
  ],
);

