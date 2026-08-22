import { and, eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import { candidateRecommendations } from "./schema.js";

export class ModerationMatching {
  constructor(private readonly db: Database) {}

  async recommendationTarget(
    memberId: string,
    recommendationId: string,
    database: Database | DatabaseTransaction = this.db,
  ) {
    return (
      await database
        .select({ memberId: candidateRecommendations.candidateMemberId })
        .from(candidateRecommendations)
        .where(
          and(
            eq(candidateRecommendations.id, recommendationId),
            eq(candidateRecommendations.memberId, memberId),
          ),
        )
        .limit(1)
    )[0]?.memberId;
  }
}
