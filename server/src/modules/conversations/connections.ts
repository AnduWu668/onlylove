import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import { conversationMessages, conversations } from "./schema.js";

export class ConnectionConversations {
  constructor(private readonly db: Database) {}

  async requesterConversationWithMessage(
    input: {
      recommendationId: string;
      requesterMemberId: string;
      recipientMemberId: string;
    },
    database: Database | DatabaseTransaction = this.db,
  ) {
    return (
      await database
        .select({ id: conversations.id })
        .from(conversations)
        .innerJoin(
          conversationMessages,
          eq(conversationMessages.conversationId, conversations.id),
        )
        .where(
          and(
            eq(conversations.type, "TWIN"),
            eq(conversations.memberId, input.recipientMemberId),
            eq(conversations.visitorMemberId, input.requesterMemberId),
            eq(conversations.recommendationId, input.recommendationId),
            eq(conversationMessages.role, "member"),
          ),
        )
        .limit(1)
    )[0];
  }

  linkRequest(
    conversationId: string,
    contactRequestId: string,
    database: DatabaseTransaction,
  ) {
    return database
      .update(conversations)
      .set({ contactRequestId })
      .where(eq(conversations.id, conversationId));
  }

  async ensureHuman(
    input: {
      connectionId: string;
      memberAId: string;
      memberBId: string;
      createdAt: Date;
    },
    database: Database | DatabaseTransaction = this.db,
  ) {
    await database
      .insert(conversations)
      .values({
        id: randomUUID(),
        type: "HUMAN",
        memberId: input.memberAId,
        visitorMemberId: input.memberBId,
        connectionId: input.connectionId,
        createdAt: input.createdAt,
      })
      .onConflictDoNothing();
    return (
      await database
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.connectionId, input.connectionId),
            eq(conversations.type, "HUMAN"),
          ),
        )
        .limit(1)
    )[0]!;
  }

  async humanState(connectionId: string, memberId: string) {
    const conversation = (
      await this.db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.connectionId, connectionId),
            eq(conversations.type, "HUMAN"),
          ),
        )
        .limit(1)
    )[0];
    if (
      !conversation ||
      (conversation.memberId !== memberId &&
        conversation.visitorMemberId !== memberId)
    ) {
      return undefined;
    }
    const lastReadSequence =
      conversation.memberId === memberId
        ? conversation.memberLastReadSequence
        : conversation.visitorLastReadSequence;
    const unreadCount = (
      await this.db
        .select({ value: sql<number>`count(*)::int` })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.conversationId, conversation.id),
            ne(conversationMessages.senderMemberId, memberId),
            gt(conversationMessages.sequence, lastReadSequence),
          ),
        )
    )[0]!.value;
    return { id: conversation.id, unreadCount };
  }

  async byRequestIds(
    requestIds: string[],
    database: Database | DatabaseTransaction = this.db,
  ) {
    if (!requestIds.length) return [];
    return database
      .select({
        anonymousCode: conversations.anonymousCode,
        contactRequestId: conversations.contactRequestId,
        id: conversations.id,
      })
      .from(conversations)
      .where(
        and(
          inArray(conversations.contactRequestId, requestIds),
          isNotNull(conversations.recommendationId),
        ),
      );
  }
}
