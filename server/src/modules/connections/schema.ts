import { index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
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
