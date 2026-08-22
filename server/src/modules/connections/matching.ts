import { and, inArray, isNull, or } from "drizzle-orm";
import type { Database } from "../../db.js";
import { connectionRecoveries, memberConnections } from "./schema.js";

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
          inArray(memberConnections.status, ["active", "confirmed"]),
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

  async membersRecovering(memberIds: string[]) {
    if (!memberIds.length) return new Set<string>();
    const rows = await this.db
      .select({ memberId: connectionRecoveries.memberId })
      .from(connectionRecoveries)
      .where(
        and(
          inArray(connectionRecoveries.memberId, memberIds),
          isNull(connectionRecoveries.resumedAt),
        ),
      );
    return new Set(rows.map(({ memberId }) => memberId));
  }
}
