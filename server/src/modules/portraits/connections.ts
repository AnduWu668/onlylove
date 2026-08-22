import { and, eq, gt, inArray } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import { portraitMemberStates, portraitVersions } from "./schema.js";

export class ConnectionPortraits {
  constructor(private readonly db: Database) {}

  async publishedVersionsMatch(
    expected: Map<string, string>,
    database: Database | DatabaseTransaction = this.db,
  ) {
    const memberIds = [...expected.keys()];
    if (!memberIds.length) return false;
    const states = await database
      .select({
        memberId: portraitMemberStates.memberId,
        publishedVersionId: portraitMemberStates.publishedVersionId,
      })
      .from(portraitMemberStates)
      .where(inArray(portraitMemberStates.memberId, memberIds));
    return (
      states.length === memberIds.length &&
      states.every(
        (state) => expected.get(state.memberId) === state.publishedVersionId,
      )
    );
  }

  async hasPublishedVersionAfter(memberId: string, after: Date) {
    const row = await this.db
      .select({ id: portraitVersions.id })
      .from(portraitMemberStates)
      .innerJoin(
        portraitVersions,
        eq(portraitMemberStates.publishedVersionId, portraitVersions.id),
      )
      .where(
        and(
          eq(portraitMemberStates.memberId, memberId),
          gt(portraitVersions.createdAt, after),
        ),
      )
      .limit(1);
    return row.length === 1;
  }
}
