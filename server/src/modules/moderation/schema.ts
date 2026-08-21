import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { members } from "../members/schema.js";

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
