import { and, desc, eq, inArray, ne, or } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import {
  candidateTwinDailyQuotas,
  agentQuotaSettingsAudits,
  conversationMessages,
  conversations,
  ownAgentDailyQuotas,
} from "./schema.js";

export class MemberConversations {
  constructor(private readonly db: Database) {}

  async privateConversationIds(
    memberId: string,
    database: Database | DatabaseTransaction = this.db,
  ) {
    return (
      await database
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            ne(conversations.type, "HUMAN"),
            or(
              eq(conversations.memberId, memberId),
              eq(conversations.visitorMemberId, memberId),
            ),
          ),
        )
    ).map(({ id }) => id);
  }

  async purgeMemberData(
    memberId: string,
    conversationIds: string[],
    database: DatabaseTransaction,
  ) {
    if (conversationIds.length) {
      await database
        .delete(conversationMessages)
        .where(inArray(conversationMessages.conversationId, conversationIds));
      await database
        .delete(conversations)
        .where(inArray(conversations.id, conversationIds));
    }
    await database
      .delete(ownAgentDailyQuotas)
      .where(eq(ownAgentDailyQuotas.memberId, memberId));
    await database
      .delete(candidateTwinDailyQuotas)
      .where(eq(candidateTwinDailyQuotas.memberId, memberId));
  }

  async administrationDetail(memberId: string, evidenceMessageIds: string[]) {
    const memberConversations = await this.db
      .select()
      .from(conversations)
      .where(
        or(
          eq(conversations.memberId, memberId),
          eq(conversations.visitorMemberId, memberId),
        ),
      )
      .orderBy(desc(conversations.createdAt));
    const conversationIds = memberConversations.map(({ id }) => id);
    const [evidence, messages] = await Promise.all([
      evidenceMessageIds.length
        ? this.db
            .select()
            .from(conversationMessages)
            .where(inArray(conversationMessages.id, evidenceMessageIds))
        : [],
      conversationIds.length
        ? this.db
            .select()
            .from(conversationMessages)
            .where(inArray(conversationMessages.conversationId, conversationIds))
            .orderBy(conversationMessages.sequence)
        : [],
    ]);
    return {
      evidence,
      conversations: memberConversations.map((conversation) => ({
        ...conversation,
        messages: messages.filter(
          (message) => message.conversationId === conversation.id,
        ),
      })),
    };
  }

  agentQuotaSettingsAudit() {
    return this.db
      .select()
      .from(agentQuotaSettingsAudits)
      .orderBy(desc(agentQuotaSettingsAudits.createdAt));
  }
}
