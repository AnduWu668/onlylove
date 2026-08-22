import { eq, inArray } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
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

  async setSuspension(
    memberId: string,
    suspendedUntil: Date | null,
    database: DatabaseTransaction,
  ) {
    await database
      .update(members)
      .set({ suspendedUntil })
      .where(eq(members.id, memberId));
  }
}
