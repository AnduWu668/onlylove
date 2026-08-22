import { and, eq, inArray } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import { candidateRecommendations } from "./schema.js";

const fields = {
  id: candidateRecommendations.id,
  memberId: candidateRecommendations.memberId,
  candidateMemberId: candidateRecommendations.candidateMemberId,
  memberPortraitVersionId: candidateRecommendations.memberPortraitVersionId,
  candidatePortraitVersionId:
    candidateRecommendations.candidatePortraitVersionId,
  memberCriteriaVersionId: candidateRecommendations.memberCriteriaVersionId,
  candidateCriteriaVersionId:
    candidateRecommendations.candidateCriteriaVersionId,
  reason: candidateRecommendations.reason,
  status: candidateRecommendations.status,
};

export class ConnectionMatching {
  constructor(private readonly db: Database) {}

  async byId(
    recommendationId: string,
    requesterMemberId?: string,
    database: Database | DatabaseTransaction = this.db,
  ) {
    return (
      await database
        .select(fields)
        .from(candidateRecommendations)
        .where(
          and(
            eq(candidateRecommendations.id, recommendationId),
            ...(requesterMemberId
              ? [eq(candidateRecommendations.memberId, requesterMemberId)]
              : []),
          ),
        )
        .limit(1)
    )[0];
  }

  async byIds(
    recommendationIds: string[],
    database: Database | DatabaseTransaction = this.db,
  ) {
    if (!recommendationIds.length) return [];
    return database
      .select(fields)
      .from(candidateRecommendations)
      .where(inArray(candidateRecommendations.id, recommendationIds));
  }

  markRequested(
    recommendationId: string,
    at: Date,
    database: DatabaseTransaction,
  ) {
    return database
      .update(candidateRecommendations)
      .set({ status: "requested", updatedAt: at })
      .where(eq(candidateRecommendations.id, recommendationId));
  }
}
