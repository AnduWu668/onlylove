import { and, eq, or } from "drizzle-orm";
import type { Database } from "../../db.js";
import { memberConnections } from "./schema.js";

export class MatchingConnections {
  constructor(private readonly db: Database) {}

  async hasCurrent(memberId: string) {
    return Boolean(
      (
        await this.db
          .select({ id: memberConnections.id })
          .from(memberConnections)
          .where(
            and(
              eq(memberConnections.status, "active"),
              or(
                eq(memberConnections.memberAId, memberId),
                eq(memberConnections.memberBId, memberId),
              ),
            ),
          )
          .limit(1)
      )[0],
    );
  }
}
