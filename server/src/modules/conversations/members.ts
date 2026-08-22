import { and, eq, inArray, ne, or } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import {
  candidateTwinDailyQuotas,
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
}
