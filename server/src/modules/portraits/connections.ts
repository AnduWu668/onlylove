import { inArray } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import { portraitMemberStates } from "./schema.js";

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
}
