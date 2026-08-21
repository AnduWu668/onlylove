import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { Database } from "../../db.js";
import { matchCriteriaVersions, members } from "./schema.js";

export type MatchingMember = typeof members.$inferSelect & {
  criteria: typeof matchCriteriaVersions.$inferSelect | undefined;
};

export class MatchingMembers {
  constructor(private readonly db: Database) {}

  async byId(memberId: string): Promise<MatchingMember | undefined> {
    const member = (
      await this.db
        .select()
        .from(members)
        .where(
          and(
            eq(members.id, memberId),
            eq(members.role, "member"),
            isNull(members.deletedAt),
          ),
        )
        .limit(1)
    )[0];
    if (!member) return undefined;
    const criteria = (
      await this.db
        .select()
        .from(matchCriteriaVersions)
        .where(eq(matchCriteriaVersions.memberId, memberId))
        .orderBy(desc(matchCriteriaVersions.version))
        .limit(1)
    )[0];
    return { ...member, criteria };
  }

  candidates(excludingMemberId: string) {
    return this.db
      .select({ id: members.id })
      .from(members)
      .where(
        and(
          ne(members.id, excludingMemberId),
          eq(members.role, "member"),
          isNull(members.deletedAt),
        ),
      );
  }
}
