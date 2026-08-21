import { and, eq, inArray, or } from "drizzle-orm";
import type { Database } from "../../db.js";
import { memberConnections } from "./schema.js";

export class MatchingConnections {
  constructor(private readonly db: Database) {}

  async membersWithCurrent(memberIds: string[]) {
    const result = new Set<string>();
    if (!memberIds.length) return result;
    const rows = await this.db
      .select({
        memberAId: memberConnections.memberAId,
        memberBId: memberConnections.memberBId,
      })
      .from(memberConnections)
      .where(
        and(
          eq(memberConnections.status, "active"),
          or(
            inArray(memberConnections.memberAId, memberIds),
            inArray(memberConnections.memberBId, memberIds),
          ),
        ),
      );
    const requested = new Set(memberIds);
    for (const row of rows) {
      if (requested.has(row.memberAId)) result.add(row.memberAId);
      if (requested.has(row.memberBId)) result.add(row.memberBId);
    }
    return result;
  }
}
