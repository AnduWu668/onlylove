import { and, asc, eq, inArray, ne, or } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import { conversationMessages, conversations } from "./schema.js";

export class ModerationConversations {
  constructor(private readonly db: Database) {}

  async messageTarget(
    reporterMemberId: string,
    messageId: string,
    kind: "twin_message" | "human_message",
    database: Database | DatabaseTransaction = this.db,
  ) {
    const row = (
      await database
        .select({ conversation: conversations, message: conversationMessages })
        .from(conversationMessages)
        .innerJoin(
          conversations,
          eq(conversationMessages.conversationId, conversations.id),
        )
        .where(
          and(
            eq(conversationMessages.id, messageId),
            kind === "twin_message"
              ? and(
                  eq(conversations.type, "TWIN"),
                  eq(conversations.visitorMemberId, reporterMemberId),
                  eq(conversationMessages.role, "agent"),
                )
              : and(
                  eq(conversations.type, "HUMAN"),
                  or(
                    eq(conversations.memberId, reporterMemberId),
                    eq(conversations.visitorMemberId, reporterMemberId),
                  ),
                  ne(conversationMessages.senderMemberId, reporterMemberId),
                ),
          ),
        )
        .limit(1)
    )[0];
    if (!row) return undefined;
    const reportedMemberId =
      kind === "twin_message"
        ? row.conversation.memberId
        : row.message.senderMemberId;
    if (!reportedMemberId) return undefined;
    return {
      reportedMemberId,
      messageId: row.message.id,
      conversationId: row.conversation.id,
      message: {
        id: row.message.id,
        content: row.message.content,
        createdAt: row.message.createdAt.toISOString(),
      },
    };
  }

  async messagesByIds(
    messageIds: string[],
    database: Database | DatabaseTransaction = this.db,
  ) {
    if (!messageIds.length) return [];
    return database
      .select()
      .from(conversationMessages)
      .where(inArray(conversationMessages.id, messageIds));
  }

  async chat(
    conversationId: string,
    database: Database | DatabaseTransaction = this.db,
  ) {
    const messages = await database
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId))
      .orderBy(asc(conversationMessages.sequence));
    return {
      conversationId,
      messages: messages.map((message) => ({
        id: message.id,
        senderMemberId: message.senderMemberId,
        role: message.role,
        content: message.content,
        sequence: message.sequence,
        createdAt: message.createdAt.toISOString(),
      })),
    };
  }
}
