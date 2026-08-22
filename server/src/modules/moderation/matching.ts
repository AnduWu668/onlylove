import { and, eq, inArray, or } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import { memberBlocks, memberRecommendationRestrictions } from "./schema.js";

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

  async restrictedMembers(
    memberIds: string[],
    database: Database | DatabaseTransaction = this.db,
  ) {
    if (!memberIds.length) return new Set<string>();
    const rows = await database
      .select({ memberId: memberRecommendationRestrictions.memberId })
      .from(memberRecommendationRestrictions)
      .where(inArray(memberRecommendationRestrictions.memberId, memberIds));
    return new Set(rows.map(({ memberId }) => memberId));
  }

  async recommendationRestricted(
    memberAId: string,
    memberBId: string,
    database: Database | DatabaseTransaction = this.db,
  ) {
    return (
      await this.restrictedMembers([memberAId, memberBId], database)
    ).size > 0;
  }
}
