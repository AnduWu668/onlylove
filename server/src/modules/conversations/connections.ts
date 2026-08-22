import { and, eq, inArray, isNotNull } from "drizzle-orm";
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
