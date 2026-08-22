import {
  boolean,
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
export type Gender = "female" | "male";
export type RequirementMode = "preferred" | "required";

export const members = pgTable(
  "members",
  {
    id: uuid("id").primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    passwordHash: varchar("password_hash", { length: 256 }),
    role: varchar("role", { length: 32 }).$type<MemberRole>().notNull(),
    birthDate: date("birth_date"),
    nickname: varchar("nickname", { length: 40 }),
    gender: varchar("gender", { length: 16 }).$type<Gender>(),
    heightCm: integer("height_cm"),
    city: varchar("city", { length: 60 }),
    occupation: varchar("occupation", { length: 80 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    suspendedUntil: timestamp("suspended_until", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("members_email_unique").on(table.email)],
);

export const matchCriteriaVersions = pgTable(
  "match_criteria_versions",
  {
    id: uuid("id").primaryKey(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    version: integer("version").notNull(),
    desiredGender: varchar("desired_gender", { length: 16 })
      .$type<Gender>()
      .notNull(),
    ageMinimum: integer("age_minimum"),
    ageMaximum: integer("age_maximum"),
    ageMode: varchar("age_mode", { length: 16 }).$type<RequirementMode>(),
    heightMinimumCm: integer("height_minimum_cm"),
    heightMaximumCm: integer("height_maximum_cm"),
    heightMode: varchar("height_mode", { length: 16 }).$type<RequirementMode>(),
    acceptableCities: varchar("acceptable_cities", { length: 60 })
      .array()
      .notNull(),
    occupationRequirement: varchar("occupation_requirement", { length: 100 }),
    occupationMode: varchar("occupation_mode", { length: 16 }).$type<RequirementMode>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("match_criteria_member_version_unique").on(
      table.memberId,
      table.version,
    ),
  ],
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
    passwordSetupRequired: boolean("password_setup_required")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_member_index").on(table.memberId),
  ],
);

export const memberDeletionAudits = pgTable(
  "member_deletion_audits",
  {
    id: uuid("id").primaryKey(),
    actorMemberId: uuid("actor_member_id")
      .notNull()
      .references(() => members.id),
    targetMemberId: uuid("target_member_id")
      .references(() => members.id),
    action: varchar("action", { length: 16 })
      .$type<"viewed" | "deleted" | "restored" | "purged">()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("member_deletion_audits_created_index").on(table.createdAt)],
);
