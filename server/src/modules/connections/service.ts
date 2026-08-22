import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import type { ConnectionConversations } from "../conversations/connections.js";
import type { ConnectionMatching } from "../matching/connections.js";
import { ageOn } from "../matching/service.js";
import type { ConnectionMembers } from "../members/connections.js";
import type { Mailer } from "../members/mailer.js";
import type { MatchingModeration } from "../moderation/matching.js";
import type { ConnectionPortraits } from "../portraits/connections.js";
import {
  contactNotificationOutbox,
  contactRequests,
  currentConnectionMembers,
  memberConnections,
} from "./schema.js";

const REQUEST_LIFETIME_MS = 7 * 24 * 60 * 60_000;

export class ConnectionsError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 409,
  ) {
    super(code);
  }
}

export class Connections {
  private notificationFlush?: Promise<void>;

  constructor(
    private readonly db: Database,
    private readonly now: () => Date,
    private readonly mailer: Mailer,
    private readonly conversations: ConnectionConversations,
    private readonly matching: ConnectionMatching,
    private readonly members: ConnectionMembers,
    private readonly moderation: MatchingModeration,
    private readonly portraits: ConnectionPortraits,
  ) {}

  private async availablePair(
    recommendation: NonNullable<
      Awaited<ReturnType<ConnectionMatching["byId"]>>
    >,
    database: Database | DatabaseTransaction,
  ) {
    const memberIds = [
      recommendation.memberId,
      recommendation.candidateMemberId,
    ];
    // A transaction owns one pg client, so keep these checks sequential.
    const pair = await this.members.eligiblePair(
      {
        requesterMemberId: recommendation.memberId,
        recipientMemberId: recommendation.candidateMemberId,
        requesterCriteriaVersionId: recommendation.memberCriteriaVersionId,
        recipientCriteriaVersionId:
          recommendation.candidateCriteriaVersionId,
      },
      this.now(),
      database,
    );
    if (!pair) return undefined;
    const blocked = await this.moderation.blocked(
      recommendation.memberId,
      recommendation.candidateMemberId,
      database,
    );
    if (blocked) return undefined;
    const publishedVersionsMatch =
      await this.portraits.publishedVersionsMatch(
        new Map([
          [recommendation.memberId, recommendation.memberPortraitVersionId],
          [
            recommendation.candidateMemberId,
            recommendation.candidatePortraitVersionId,
          ],
        ]),
        database,
      );
    if (!publishedVersionsMatch) return undefined;
    const currentConnection = await database
      .select({ id: memberConnections.id })
      .from(memberConnections)
      .where(
        and(
          eq(memberConnections.status, "active"),
          or(
            inArray(memberConnections.memberAId, memberIds),
            inArray(memberConnections.memberBId, memberIds),
          ),
        ),
      )
      .limit(1);
    const currentMembership = await database
      .select({ memberId: currentConnectionMembers.memberId })
      .from(currentConnectionMembers)
      .where(inArray(currentConnectionMembers.memberId, memberIds))
      .limit(1);
    return currentConnection.length || currentMembership.length
      ? undefined
      : pair;
  }

  async createRequest(requesterMemberId: string, recommendationId: string) {
    const createdAt = this.now();
    const result = await this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`contact-request:${recommendationId}`}))`,
      );
      const recommendation = await this.matching.byId(
        recommendationId,
        requesterMemberId,
        transaction,
      );
      if (!recommendation) {
        throw new ConnectionsError("RECOMMENDATION_NOT_FOUND", 404);
      }
      const existing = (
        await transaction
          .select()
          .from(contactRequests)
          .where(eq(contactRequests.recommendationId, recommendationId))
          .limit(1)
      )[0];
      if (existing) return { created: false as const, request: existing };
      if (!["pending", "rechecking"].includes(recommendation.status)) {
        throw new ConnectionsError("CONTACT_REQUEST_NOT_AVAILABLE");
      }
      for (const memberId of [
        recommendation.memberId,
        recommendation.candidateMemberId,
      ].sort()) {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`current-contact:${memberId}`}))`,
        );
      }
      const pair = await this.availablePair(recommendation, transaction);
      if (!pair) throw new ConnectionsError("CONTACT_REQUEST_NOT_AVAILABLE");
      const conversation =
        await this.conversations.requesterConversationWithMessage(
          {
            recommendationId,
            requesterMemberId,
            recipientMemberId: recommendation.candidateMemberId,
          },
          transaction,
        );
      if (!conversation) {
        throw new ConnectionsError("CANDIDATE_TWIN_CONVERSATION_REQUIRED");
      }
      const request = (
        await transaction
          .insert(contactRequests)
          .values({
            id: randomUUID(),
            recommendationId,
            requesterMemberId,
            recipientMemberId: recommendation.candidateMemberId,
            status: "pending",
            createdAt,
            expiresAt: new Date(createdAt.getTime() + REQUEST_LIFETIME_MS),
          })
          .returning()
      )[0]!;
      await this.matching.markRequested(
        recommendationId,
        createdAt,
        transaction,
      );
      await this.conversations.linkRequest(
        conversation.id,
        request.id,
        transaction,
      );
      await transaction.insert(contactNotificationOutbox).values({
        id: randomUUID(),
        contactRequestId: request.id,
        type: "contact_request",
        email: pair.recipient.email,
        nickname: pair.requester.nickname ?? "一位候选人",
        createdAt,
      });
      return {
        created: true as const,
        request,
      };
    });
    await this.flushNotifications();
    return {
      created: result.created,
      request: this.publicRequest(result.request),
    };
  }

  async requesterForTwinConversation(
    recipientMemberId: string,
    requestId: string,
    expectedRequesterMemberId?: string,
    transaction?: DatabaseTransaction,
  ) {
    const database = transaction ?? this.db;
    const request = (
      await database
        .select()
        .from(contactRequests)
        .where(
          and(
            eq(contactRequests.id, requestId),
            eq(contactRequests.recipientMemberId, recipientMemberId),
            eq(contactRequests.status, "pending"),
            gt(contactRequests.expiresAt, this.now()),
          ),
        )
        .limit(1)
    )[0];
    if (
      !request ||
      (expectedRequesterMemberId &&
        request.requesterMemberId !== expectedRequesterMemberId)
    ) {
      return undefined;
    }
    const recommendation = await this.matching.byId(
      request.recommendationId,
      undefined,
      database,
    );
    if (
      !recommendation ||
      !(await this.availablePair(recommendation, database))
    ) {
      return undefined;
    }
    return request.requesterMemberId;
  }

  private publicRequest(request: typeof contactRequests.$inferSelect) {
    return {
      id: request.id,
      status: request.status,
      createdAt: request.createdAt.toISOString(),
      expiresAt: request.expiresAt.toISOString(),
    };
  }

  private async expirePending() {
    const at = this.now();
    await this.db
      .update(contactRequests)
      .set({ status: "expired", resolvedAt: at })
      .where(
        and(
          eq(contactRequests.status, "pending"),
          lte(contactRequests.expiresAt, at),
        ),
      );
  }

  private async deliverNotifications() {
    const pending = await this.db
      .select({ id: contactNotificationOutbox.id })
      .from(contactNotificationOutbox)
      .where(isNull(contactNotificationOutbox.sentAt))
      .orderBy(contactNotificationOutbox.createdAt);
    for (const { id } of pending) {
      await this.db.transaction(async (transaction) => {
        const notification = (
          await transaction
            .select()
            .from(contactNotificationOutbox)
            .where(
              and(
                eq(contactNotificationOutbox.id, id),
                isNull(contactNotificationOutbox.sentAt),
              ),
            )
            .limit(1)
            .for("update", { skipLocked: true })
        )[0];
        if (!notification) return;
        try {
          if (notification.type === "contact_request") {
            if (!this.mailer.sendContactRequest) return;
            await this.mailer.sendContactRequest(
              notification.email,
              notification.nickname,
            );
          } else {
            if (!this.mailer.sendContactAccepted) return;
            await this.mailer.sendContactAccepted(
              notification.email,
              notification.nickname,
            );
          }
        } catch {
          return;
        }
        await transaction
          .update(contactNotificationOutbox)
          .set({ sentAt: this.now() })
          .where(eq(contactNotificationOutbox.id, notification.id));
      });
    }
  }

  private async flushNotifications() {
    if (!this.notificationFlush) {
      const run = this.deliverNotifications().finally(() => {
        if (this.notificationFlush === run) this.notificationFlush = undefined;
      });
      this.notificationFlush = run;
    }
    await this.notificationFlush;
  }

  async runMaintenance() {
    await this.expirePending();
    await this.flushNotifications();
  }

  async acceptRequest(recipientMemberId: string, requestId: string) {
    const acceptedAt = this.now();
    const result = await this.db.transaction(async (transaction) => {
      const initial = (
        await transaction
          .select()
          .from(contactRequests)
          .where(eq(contactRequests.id, requestId))
          .limit(1)
      )[0];
      if (!initial) throw new ConnectionsError("CONTACT_REQUEST_NOT_FOUND", 404);
      if (initial.requesterMemberId === recipientMemberId) {
        throw new ConnectionsError("CONTACT_REQUEST_RECIPIENT_REQUIRED", 403);
      }
      if (initial.recipientMemberId !== recipientMemberId) {
        throw new ConnectionsError("CONTACT_REQUEST_NOT_FOUND", 404);
      }
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`contact-request:${requestId}`}))`,
      );
      for (const memberId of [
        initial.requesterMemberId,
        initial.recipientMemberId,
      ].sort()) {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`current-contact:${memberId}`}))`,
        );
      }
      const current = (
        await transaction
          .select()
          .from(contactRequests)
          .where(eq(contactRequests.id, requestId))
          .limit(1)
      )[0]!;
      if (current.status === "accepted" && current.connectionId) {
        const connection = (
          await transaction
            .select()
            .from(memberConnections)
            .where(eq(memberConnections.id, current.connectionId))
            .limit(1)
        )[0]!;
        await this.conversations.ensureHuman(
          {
            connectionId: connection.id,
            memberAId: connection.memberAId,
            memberBId: connection.memberBId,
            createdAt: connection.createdAt,
          },
          transaction,
        );
        return { accepted: false as const, connection };
      }
      if (current.status !== "pending") {
        return {
          error:
            current.status === "cancelled"
              ? "CONTACT_REQUEST_CANCELLED"
              : current.status === "expired"
                ? "CONTACT_REQUEST_EXPIRED"
                : "CONTACT_REQUEST_ALREADY_RESOLVED",
        } as const;
      }
      if (current.expiresAt <= acceptedAt) {
        await transaction
          .update(contactRequests)
          .set({ status: "expired", resolvedAt: acceptedAt })
          .where(eq(contactRequests.id, current.id));
        return { error: "CONTACT_REQUEST_EXPIRED" } as const;
      }
      const recommendation = await this.matching.byId(
        current.recommendationId,
        undefined,
        transaction,
      );
      const pair = recommendation
        ? await this.availablePair(recommendation, transaction)
        : undefined;
      if (!recommendation || !pair) {
        await transaction
          .update(contactRequests)
          .set({ status: "cancelled", resolvedAt: acceptedAt })
          .where(eq(contactRequests.id, current.id));
        return { error: "CONTACT_REQUEST_CANCELLED" } as const;
      }
      const connection = (
        await transaction
          .insert(memberConnections)
          .values({
            id: randomUUID(),
            memberAId: current.requesterMemberId,
            memberBId: current.recipientMemberId,
            status: "active",
            createdAt: acceptedAt,
          })
          .returning()
      )[0]!;
      await this.conversations.ensureHuman(
        {
          connectionId: connection.id,
          memberAId: connection.memberAId,
          memberBId: connection.memberBId,
          createdAt: connection.createdAt,
        },
        transaction,
      );
      await transaction.insert(currentConnectionMembers).values([
        {
          memberId: current.requesterMemberId,
          connectionId: connection.id,
          createdAt: acceptedAt,
        },
        {
          memberId: current.recipientMemberId,
          connectionId: connection.id,
          createdAt: acceptedAt,
        },
      ]);
      await transaction
        .update(contactRequests)
        .set({
          status: "accepted",
          connectionId: connection.id,
          resolvedAt: acceptedAt,
        })
        .where(eq(contactRequests.id, current.id));
      const involvesCurrentMembers = or(
        inArray(contactRequests.requesterMemberId, [
          current.requesterMemberId,
          current.recipientMemberId,
        ]),
        inArray(contactRequests.recipientMemberId, [
          current.requesterMemberId,
          current.recipientMemberId,
        ]),
      );
      await transaction
        .update(contactRequests)
        .set({ status: "expired", resolvedAt: acceptedAt })
        .where(
          and(
            eq(contactRequests.status, "pending"),
            lte(contactRequests.expiresAt, acceptedAt),
            involvesCurrentMembers,
          ),
        );
      await transaction
        .update(contactRequests)
        .set({ status: "cancelled", resolvedAt: acceptedAt })
        .where(
          and(
            eq(contactRequests.status, "pending"),
            ne(contactRequests.id, current.id),
            involvesCurrentMembers,
          ),
        );
      await transaction.insert(contactNotificationOutbox).values([
        {
          id: randomUUID(),
          contactRequestId: current.id,
          type: "contact_accepted",
          email: pair.requester.email,
          nickname: pair.recipient.nickname ?? "对方",
          createdAt: acceptedAt,
        },
        {
          id: randomUUID(),
          contactRequestId: current.id,
          type: "contact_accepted",
          email: pair.recipient.email,
          nickname: pair.requester.nickname ?? "对方",
          createdAt: acceptedAt,
        },
      ]);
      return {
        accepted: true as const,
        connection,
      };
    });
    if ("error" in result && result.error) {
      throw new ConnectionsError(result.error);
    }
    await this.flushNotifications();
    return {
      connection: {
        id: result.connection.id,
        createdAt: result.connection.createdAt.toISOString(),
      },
    };
  }

  async rejectRequest(recipientMemberId: string, requestId: string) {
    const rejectedAt = this.now();
    const result = await this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`contact-request:${requestId}`}))`,
      );
      const request = (
        await transaction
          .select()
          .from(contactRequests)
          .where(eq(contactRequests.id, requestId))
          .limit(1)
      )[0];
      if (!request) throw new ConnectionsError("CONTACT_REQUEST_NOT_FOUND", 404);
      if (request.requesterMemberId === recipientMemberId) {
        throw new ConnectionsError("CONTACT_REQUEST_RECIPIENT_REQUIRED", 403);
      }
      if (request.recipientMemberId !== recipientMemberId) {
        throw new ConnectionsError("CONTACT_REQUEST_NOT_FOUND", 404);
      }
      if (request.status === "rejected") return { request };
      if (request.status !== "pending") {
        return { error: "CONTACT_REQUEST_ALREADY_RESOLVED" } as const;
      }
      if (request.expiresAt <= rejectedAt) {
        await transaction
          .update(contactRequests)
          .set({ status: "expired", resolvedAt: rejectedAt })
          .where(eq(contactRequests.id, request.id));
        return { error: "CONTACT_REQUEST_EXPIRED" } as const;
      }
      const rejected = (
        await transaction
          .update(contactRequests)
          .set({ status: "rejected", resolvedAt: rejectedAt })
          .where(eq(contactRequests.id, request.id))
          .returning()
      )[0]!;
      return { request: rejected };
    });
    if ("error" in result && result.error) {
      throw new ConnectionsError(result.error);
    }
    return this.publicRequest(result.request!);
  }

  private async currentConnection(memberId: string) {
    const row = (
      await this.db
        .select({ connection: memberConnections })
        .from(currentConnectionMembers)
        .innerJoin(
          memberConnections,
          eq(currentConnectionMembers.connectionId, memberConnections.id),
        )
        .where(eq(currentConnectionMembers.memberId, memberId))
        .limit(1)
    )[0];
    if (!row) return null;
    await this.conversations.ensureHuman({
      connectionId: row.connection.id,
      memberAId: row.connection.memberAId,
      memberBId: row.connection.memberBId,
      createdAt: row.connection.createdAt,
    });
    const conversation = await this.conversations.humanState(
      row.connection.id,
      memberId,
    );
    const otherMemberId =
      row.connection.memberAId === memberId
        ? row.connection.memberBId
        : row.connection.memberAId;
    const candidate = (await this.members.byIds([otherMemberId]))[0];
    return {
      id: row.connection.id,
      createdAt: row.connection.createdAt.toISOString(),
      conversation,
      candidate: candidate
        ? {
            avatarText: candidate.nickname?.trim().slice(0, 1) || "爱",
            nickname: candidate.nickname ?? "联系成员",
            age: ageOn(candidate.birthDate, this.now()),
            heightCm: candidate.heightCm,
            city: candidate.city ?? "",
            occupation: candidate.occupation ?? "",
          }
        : null,
    };
  }

  async state(memberId: string) {
    await this.runMaintenance();
    const [requests, currentConnection] = await Promise.all([
      this.db
        .select()
        .from(contactRequests)
        .where(
          or(
            eq(contactRequests.requesterMemberId, memberId),
            eq(contactRequests.recipientMemberId, memberId),
          ),
        )
        .orderBy(desc(contactRequests.createdAt)),
      this.currentConnection(memberId),
    ]);
    if (!requests.length) {
      return { incoming: [], outgoing: [], currentConnection };
    }
    const [recommendations, memberRows, conversationRows] = await Promise.all([
      this.matching.byIds(
        requests.map((request) => request.recommendationId),
      ),
      this.members.byIds(
        requests.flatMap((request) => [
          request.requesterMemberId,
          request.recipientMemberId,
        ]),
      ),
      this.conversations.byRequestIds(requests.map((request) => request.id)),
    ]);
    const recommendationById = new Map(
      recommendations.map((recommendation) => [recommendation.id, recommendation]),
    );
    const memberById = new Map(memberRows.map((member) => [member.id, member]));
    const conversationByRequestId = new Map(
      conversationRows.map((conversation) => [
        conversation.contactRequestId,
        conversation,
      ]),
    );
    const publicState = (request: typeof contactRequests.$inferSelect) => {
      const incoming = request.recipientMemberId === memberId;
      const candidate = memberById.get(
        incoming ? request.requesterMemberId : request.recipientMemberId,
      )!;
      const recommendation = recommendationById.get(request.recommendationId)!;
      const conversation = conversationByRequestId.get(request.id);
      return {
        ...this.publicRequest(request),
        ...(request.status === "cancelled"
          ? {
              resolutionMessage:
                "你或对方已建立其他联系，此请求已由系统取消。",
            }
          : {}),
        ...(request.status === "expired"
          ? { resolutionMessage: "请求已过期，不计为拒绝。" }
          : {}),
        candidate: {
          avatarText: candidate.nickname?.trim().slice(0, 1) || "爱",
          nickname: candidate.nickname ?? "候选成员",
          age: ageOn(candidate.birthDate, this.now()),
          heightCm: candidate.heightCm,
          city: candidate.city ?? "",
          occupation: candidate.occupation ?? "",
          reason: incoming
            ? "你们的公开资料和择偶条件相互匹配。"
            : recommendation.reason,
        },
        ...(incoming && conversation
          ? {
              conversation: {
                id: conversation.id,
                anonymousCode: conversation.anonymousCode,
              },
            }
          : {}),
      };
    };
    return {
      incoming: requests
        .filter((request) => request.recipientMemberId === memberId)
        .map(publicState),
      outgoing: requests
        .filter((request) => request.requesterMemberId === memberId)
        .map(publicState),
      currentConnection,
    };
  }
}
