import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import {
  connectionRecoveries,
  contactRequests,
  currentConnectionMembers,
  memberConnections,
} from "./schema.js";

export class ModerationConnections {
  constructor(private readonly db: Database) {}

  private async lockCurrentContacts(
    memberIds: string[],
    database: DatabaseTransaction,
  ) {
    for (const memberId of [...new Set(memberIds)].sort()) {
      await database.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`current-contact:${memberId}`}))`,
      );
    }
  }

  private async endConnections(
    condition: SQL,
    endedAt: Date,
    database: DatabaseTransaction,
  ) {
    const connectionIds = (
      await database
        .select({ id: memberConnections.id })
        .from(memberConnections)
        .where(
          and(
            inArray(memberConnections.status, ["active", "confirmed"]),
            condition,
          ),
        )
    ).map(({ id }) => id);
    for (const connectionId of connectionIds.sort()) {
      await database.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`connection:${connectionId}`}))`,
      );
    }
    if (!connectionIds.length) return [];
    return database
      .update(memberConnections)
      .set({ status: "ended", endedAt })
      .where(
        and(
          inArray(memberConnections.id, connectionIds),
          inArray(memberConnections.status, ["active", "confirmed"]),
        ),
      )
      .returning();
  }

  async target(
    memberId: string,
    kind: "contact_request" | "connection",
    targetId: string,
    database: Database | DatabaseTransaction = this.db,
  ) {
    if (kind === "contact_request") {
      const request = (
        await database
          .select()
          .from(contactRequests)
          .where(
            and(
              eq(contactRequests.id, targetId),
              or(
                eq(contactRequests.requesterMemberId, memberId),
                eq(contactRequests.recipientMemberId, memberId),
              ),
            ),
          )
          .limit(1)
      )[0];
      if (!request) return undefined;
      return request.requesterMemberId === memberId
        ? request.recipientMemberId
        : request.requesterMemberId;
    }
    const connection = (
      await database
        .select()
        .from(memberConnections)
        .where(
          and(
            eq(memberConnections.id, targetId),
            or(
              eq(memberConnections.memberAId, memberId),
              eq(memberConnections.memberBId, memberId),
            ),
          ),
        )
        .limit(1)
    )[0];
    if (!connection) return undefined;
    return connection.memberAId === memberId
      ? connection.memberBId
      : connection.memberAId;
  }

  async endBetween(
    memberAId: string,
    memberBId: string,
    endedAt: Date,
    database: DatabaseTransaction,
  ) {
    await this.lockCurrentContacts([memberAId, memberBId], database);
    const pair = or(
      and(
        eq(memberConnections.memberAId, memberAId),
        eq(memberConnections.memberBId, memberBId),
      ),
      and(
        eq(memberConnections.memberAId, memberBId),
        eq(memberConnections.memberBId, memberAId),
      ),
    )!;
    const requestPair = or(
      and(
        eq(contactRequests.requesterMemberId, memberAId),
        eq(contactRequests.recipientMemberId, memberBId),
      ),
      and(
        eq(contactRequests.requesterMemberId, memberBId),
        eq(contactRequests.recipientMemberId, memberAId),
      ),
    );
    await database
      .update(contactRequests)
      .set({ status: "cancelled", resolvedAt: endedAt })
      .where(and(eq(contactRequests.status, "pending"), requestPair));
    const ended = await this.endConnections(pair, endedAt, database);
    await this.finishConnections(ended, endedAt, database);
  }

  async endForMember(
    memberId: string,
    endedAt: Date,
    database: DatabaseTransaction,
  ) {
    await this.lockCurrentContacts([memberId], database);
    await database
      .update(contactRequests)
      .set({ status: "cancelled", resolvedAt: endedAt })
      .where(
        and(
          eq(contactRequests.status, "pending"),
          or(
            eq(contactRequests.requesterMemberId, memberId),
            eq(contactRequests.recipientMemberId, memberId),
          ),
        ),
      );
    const ended = await this.endConnections(
      or(
        eq(memberConnections.memberAId, memberId),
        eq(memberConnections.memberBId, memberId),
      )!,
      endedAt,
      database,
    );
    await this.finishConnections(ended, endedAt, database);
  }

  private async finishConnections(
    ended: Array<typeof memberConnections.$inferSelect>,
    endedAt: Date,
    database: DatabaseTransaction,
  ) {
    if (!ended.length) return;
    await database
      .delete(currentConnectionMembers)
      .where(
        inArray(
          currentConnectionMembers.connectionId,
          ended.map(({ id }) => id),
        ),
      );
    await database
      .insert(connectionRecoveries)
      .values(
        ended.flatMap((connection) =>
          [connection.memberAId, connection.memberBId].map((memberId) => ({
            connectionId: connection.id,
            memberId,
            createdAt: endedAt,
          })),
        ),
      )
      .onConflictDoNothing();
  }
}
