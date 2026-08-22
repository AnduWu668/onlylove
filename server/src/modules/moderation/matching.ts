import { and, eq, inArray, or } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import { memberBlocks } from "./schema.js";

export class MatchingModeration {
  constructor(private readonly db: Database) {}

  async blockedCandidates(
    memberId: string,
    candidateIds: string[],
    database: Database | DatabaseTransaction = this.db,
  ) {
    const result = new Set<string>();
    if (!candidateIds.length) return result;
    const rows = await database
      .select({
        blockerMemberId: memberBlocks.blockerMemberId,
        blockedMemberId: memberBlocks.blockedMemberId,
      })
      .from(memberBlocks)
      .where(
        or(
          and(
            eq(memberBlocks.blockerMemberId, memberId),
            inArray(memberBlocks.blockedMemberId, candidateIds),
          ),
          and(
            eq(memberBlocks.blockedMemberId, memberId),
            inArray(memberBlocks.blockerMemberId, candidateIds),
          ),
        ),
      );
    for (const row of rows) {
      result.add(
        row.blockerMemberId === memberId
          ? row.blockedMemberId
          : row.blockerMemberId,
      );
    }
    return result;
  }

  async blocked(
    memberAId: string,
    memberBId: string,
    database: Database | DatabaseTransaction = this.db,
  ) {
    return (
      await this.blockedCandidates(memberAId, [memberBId], database)
    ).has(memberBId);
  }
}
