import { randomUUID } from "node:crypto";
import { and, asc, eq, lte, max } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import { conversationMessages, conversations } from "./schema.js";

export class InterviewConversations {
  constructor(private readonly db: Database) {}

  private async appendMemberMessage(
    transaction: DatabaseTransaction,
    memberId: string,
    type: "INTERVIEW",
    content: string,
    createdAt: Date,
    clientMessageId?: string,
  ) {
    await transaction
      .insert(conversations)
      .values({
        id: randomUUID(),
        type,
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
            eq(conversations.type, type),
          ),
        )
        .limit(1)
    )[0]!;
    if (clientMessageId) {
      const existing = (
        await transaction
          .select({
            id: conversationMessages.id,
            sequence: conversationMessages.sequence,
          })
          .from(conversationMessages)
          .where(
            and(
              eq(conversationMessages.conversationId, conversation.id),
              eq(conversationMessages.clientMessageId, clientMessageId),
            ),
          )
          .limit(1)
      )[0];
      if (existing) return { ...existing, conversationId: conversation.id };
    }
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
          clientMessageId,
          createdAt,
        })
        .returning({
          id: conversationMessages.id,
          sequence: conversationMessages.sequence,
        })
    )[0]!;
    return { ...message, conversationId: conversation.id };
  }

  appendFixedAnswer(
    transaction: DatabaseTransaction,
    memberId: string,
    content: string,
    createdAt: Date,
  ) {
    return this.appendMemberMessage(
      transaction,
      memberId,
      "INTERVIEW",
      content,
      createdAt,
    );
  }

  appendCalibrationCorrections(
    transaction: DatabaseTransaction,
    memberId: string,
    content: string,
    createdAt: Date,
  ) {
    return this.appendMemberMessage(
      transaction,
      memberId,
      "INTERVIEW",
      content,
      createdAt,
    );
  }

  appendSelfTwinEvidence(
    transaction: DatabaseTransaction,
    memberId: string,
    sourceMessageId: string,
    content: string,
    createdAt: Date,
  ) {
    return this.appendMemberMessage(
      transaction,
      memberId,
      "INTERVIEW",
      `成员与自己的恋爱分身对话（只有明确自述或纠正可作为画像证据，提问不能视为成员事实）：\n${content}`,
      createdAt,
      sourceMessageId,
    );
  }

  memberEvidence(
    conversationId: string,
    throughSequence: number,
    database: Database | DatabaseTransaction = this.db,
  ) {
    return database
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

  agentQuestionsForMember(memberId: string) {
    return this.db
      .select({ content: conversationMessages.content })
      .from(conversationMessages)
      .innerJoin(
        conversations,
        eq(conversations.id, conversationMessages.conversationId),
      )
      .where(
        and(
          eq(conversations.memberId, memberId),
          eq(conversations.type, "INTERVIEW"),
          eq(conversationMessages.role, "agent"),
        ),
      );
  }

  async conversationIdForMember(
    memberId: string,
    type: "INTERVIEW" | "TWIN",
  ) {
    return (
      await this.db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(eq(conversations.memberId, memberId), eq(conversations.type, type)),
        )
        .limit(1)
    )[0]?.id;
  }

  async conversationForMessage(
    transaction: DatabaseTransaction,
    messageId: string,
  ) {
    return (
      await transaction
        .select({ conversationId: conversationMessages.conversationId })
        .from(conversationMessages)
        .where(eq(conversationMessages.id, messageId))
        .limit(1)
    )[0];
  }
}
