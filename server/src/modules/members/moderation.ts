import { eq, inArray } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import type { ModerationAction } from "../moderation/schema.js";
import { members } from "./schema.js";

export const PERMANENT_BAN_UNTIL = new Date("9999-12-31T23:59:59.999Z");

export class ModerationMembers {
  constructor(private readonly db: Database) {}

  async byIds(
    memberIds: string[],
    database: Database | DatabaseTransaction = this.db,
  ) {
    if (!memberIds.length) return [];
    return database
      .select({
        id: members.id,
        email: members.email,
        nickname: members.nickname,
        role: members.role,
        deletedAt: members.deletedAt,
        suspendedUntil: members.suspendedUntil,
      })
      .from(members)
      .where(inArray(members.id, memberIds));
  }

  async applyDecision(
    memberId: string,
    action: ModerationAction,
    suspendedUntil: Date | undefined,
    database: DatabaseTransaction,
  ) {
    if (action !== "suspended" && action !== "banned") return;
    await database
      .update(members)
      .set({
        suspendedUntil:
          action === "banned" ? PERMANENT_BAN_UNTIL : suspendedUntil,
      })
      .where(eq(members.id, memberId));
  }

  async clearSuspension(memberId: string, database: DatabaseTransaction) {
    await database
      .update(members)
      .set({ suspendedUntil: null })
      .where(eq(members.id, memberId));
  }
}
