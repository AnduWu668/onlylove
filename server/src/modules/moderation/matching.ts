import { and, eq, or } from "drizzle-orm";
import type { Database } from "../../db.js";
import { memberBlocks } from "./schema.js";

export class MatchingModeration {
  constructor(private readonly db: Database) {}

  async blocked(memberAId: string, memberBId: string) {
    return Boolean(
      (
        await this.db
          .select({ blockerMemberId: memberBlocks.blockerMemberId })
          .from(memberBlocks)
          .where(
            or(
              and(
                eq(memberBlocks.blockerMemberId, memberAId),
                eq(memberBlocks.blockedMemberId, memberBId),
              ),
              and(
                eq(memberBlocks.blockerMemberId, memberBId),
                eq(memberBlocks.blockedMemberId, memberAId),
              ),
            ),
          )
          .limit(1)
      )[0],
    );
  }
}
