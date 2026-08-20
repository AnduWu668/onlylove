import { randomUUID } from "node:crypto";
import { and, asc, eq, lte, max } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import { conversationMessages, conversations } from "./schema.js";

export class InterviewConversations {
  constructor(private readonly db: Database) {}

  async appendFixedAnswer(
    transaction: DatabaseTransaction,
    memberId: string,
    content: string,
    createdAt: Date,
  ) {
    await transaction
      .insert(conversations)
      .values({
        id: randomUUID(),
        type: "INTERVIEW",
        memberId,
        createdAt,
      })
      .onConflictDoNothing();
    const conversation = (
      await transaction
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.memberId, memberId),
            eq(conversations.type, "INTERVIEW"),
          ),
        )
        .limit(1)
    )[0]!;
    const lastSequence = (
      await transaction
        .select({ value: max(conversationMessages.sequence) })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, conversation.id))
    )[0]?.value;
    const message = (
      await transaction
        .insert(conversationMessages)
        .values({
          id: randomUUID(),
          conversationId: conversation.id,
          role: "member",
          content,
          sequence: (lastSequence ?? 0) + 1,
          createdAt,
        })
        .returning({
          id: conversationMessages.id,
          sequence: conversationMessages.sequence,
        })
    )[0]!;
    return { ...message, conversationId: conversation.id };
  }

  memberEvidence(conversationId: string, throughSequence: number) {
    return this.db
      .select({
        id: conversationMessages.id,
        content: conversationMessages.content,
        sequence: conversationMessages.sequence,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, conversationId),
          eq(conversationMessages.role, "member"),
          lte(conversationMessages.sequence, throughSequence),
        ),
      )
      .orderBy(asc(conversationMessages.sequence));
  }
}
