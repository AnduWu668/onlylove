import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import { conversationMessages, conversations } from "../conversations/schema.js";
import { candidateRecommendations } from "../matching/schema.js";
import { ageOn } from "../matching/service.js";
import type { Mailer } from "../members/mailer.js";
import { matchCriteriaVersions, members } from "../members/schema.js";
import { memberBlocks } from "../moderation/schema.js";
import { portraitMemberStates } from "../portraits/schema.js";
import {
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
  constructor(
    private readonly db: Database,
    private readonly now: () => Date,
    private readonly mailer: Mailer,
  ) {}

  private async availablePair(
    recommendation: typeof candidateRecommendations.$inferSelect,
    database: Database | DatabaseTransaction,
  ) {
    const memberIds = [
      recommendation.memberId,
      recommendation.candidateMemberId,
    ];
    // A transaction owns one pg client, so keep these checks sequential.
    const memberRows = await database
      .select()
      .from(members)
      .where(
        and(
          inArray(members.id, memberIds),
          eq(members.role, "member"),
          isNull(members.deletedAt),
        ),
      );
    const criteriaRows = await database
      .select({
        id: matchCriteriaVersions.id,
        memberId: matchCriteriaVersions.memberId,
      })
      .from(matchCriteriaVersions)
      .where(inArray(matchCriteriaVersions.memberId, memberIds))
      .orderBy(desc(matchCriteriaVersions.version));
    const portraitRows = await database
      .select()
      .from(portraitMemberStates)
      .where(inArray(portraitMemberStates.memberId, memberIds));
    const block = await database
      .select({ blockerMemberId: memberBlocks.blockerMemberId })
      .from(memberBlocks)
      .where(
        or(
          and(
            eq(memberBlocks.blockerMemberId, recommendation.memberId),
            eq(
              memberBlocks.blockedMemberId,
              recommendation.candidateMemberId,
            ),
          ),
          and(
            eq(
              memberBlocks.blockerMemberId,
              recommendation.candidateMemberId,
            ),
            eq(memberBlocks.blockedMemberId, recommendation.memberId),
          ),
        ),
      )
      .limit(1);
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
    const memberById = new Map(memberRows.map((member) => [member.id, member]));
    const latestCriteria = new Map<string, string>();
    for (const criteria of criteriaRows) {
      if (!latestCriteria.has(criteria.memberId)) {
        latestCriteria.set(criteria.memberId, criteria.id);
      }
    }
    const portraitById = new Map(
      portraitRows.map((portrait) => [portrait.memberId, portrait]),
    );
    if (
      memberById.size !== 2 ||
      memberRows.some(
        (member) =>
          member.suspendedUntil && member.suspendedUntil > this.now(),
      ) ||
      block.length ||
      currentConnection.length ||
      currentMembership.length ||
      latestCriteria.get(recommendation.memberId) !==
        recommendation.memberCriteriaVersionId ||
      latestCriteria.get(recommendation.candidateMemberId) !==
        recommendation.candidateCriteriaVersionId ||
      portraitById.get(recommendation.memberId)?.publishedVersionId !==
        recommendation.memberPortraitVersionId ||
      portraitById.get(recommendation.candidateMemberId)?.publishedVersionId !==
        recommendation.candidatePortraitVersionId
    ) {
      return undefined;
    }
    return {
      requester: memberById.get(recommendation.memberId)!,
      recipient: memberById.get(recommendation.candidateMemberId)!,
    };
  }

  async createRequest(requesterMemberId: string, recommendationId: string) {
    const createdAt = this.now();
    const result = await this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`contact-request:${recommendationId}`}))`,
      );
      const recommendation = (
        await transaction
          .select()
          .from(candidateRecommendations)
          .where(
            and(
              eq(candidateRecommendations.id, recommendationId),
              eq(candidateRecommendations.memberId, requesterMemberId),
            ),
          )
          .limit(1)
      )[0];
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
      const pair = await this.availablePair(recommendation, transaction);
      if (!pair) throw new ConnectionsError("CONTACT_REQUEST_NOT_AVAILABLE");
      const conversation = (
        await transaction
          .select({ id: conversations.id })
          .from(conversations)
          .innerJoin(
            conversationMessages,
            eq(conversationMessages.conversationId, conversations.id),
          )
          .where(
            and(
              eq(conversations.type, "TWIN"),
              eq(conversations.memberId, recommendation.candidateMemberId),
              eq(conversations.visitorMemberId, requesterMemberId),
              eq(conversations.recommendationId, recommendationId),
              eq(conversationMessages.role, "member"),
            ),
          )
          .limit(1)
      )[0];
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
      await transaction
        .update(candidateRecommendations)
        .set({ status: "requested", updatedAt: createdAt })
        .where(eq(candidateRecommendations.id, recommendationId));
      await transaction
        .update(conversations)
        .set({ contactRequestId: request.id })
        .where(eq(conversations.id, conversation.id));
      return {
        created: true as const,
        recipientEmail: pair.recipient.email,
        requesterNickname: pair.requester.nickname ?? "一位候选人",
        request,
      };
    });
    if (result.created) {
      await this.mailer.sendContactRequest?.(
        result.recipientEmail,
        result.requesterNickname,
      );
    }
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
    const recommendation = (
      await database
        .select()
        .from(candidateRecommendations)
        .where(eq(candidateRecommendations.id, request.recommendationId))
        .limit(1)
    )[0];
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
      const recommendation = (
        await transaction
          .select()
          .from(candidateRecommendations)
          .where(eq(candidateRecommendations.id, current.recommendationId))
          .limit(1)
      )[0];
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
      await transaction
        .update(contactRequests)
        .set({ status: "cancelled", resolvedAt: acceptedAt })
        .where(
          and(
            eq(contactRequests.status, "pending"),
            ne(contactRequests.id, current.id),
            or(
              inArray(contactRequests.requesterMemberId, [
                current.requesterMemberId,
                current.recipientMemberId,
              ]),
              inArray(contactRequests.recipientMemberId, [
                current.requesterMemberId,
                current.recipientMemberId,
              ]),
            ),
          ),
        );
      return {
        accepted: true as const,
        connection,
        recipient: pair.recipient,
        requester: pair.requester,
      };
    });
    if ("error" in result && result.error) {
      throw new ConnectionsError(result.error);
    }
    if (result.accepted) {
      await Promise.all([
        this.mailer.sendContactAccepted?.(
          result.requester.email,
          result.recipient.nickname ?? "对方",
        ),
        this.mailer.sendContactAccepted?.(
          result.recipient.email,
          result.requester.nickname ?? "对方",
        ),
      ]);
    }
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
    const otherMemberId =
      row.connection.memberAId === memberId
        ? row.connection.memberBId
        : row.connection.memberAId;
    const candidate = (
      await this.db
        .select()
        .from(members)
        .where(eq(members.id, otherMemberId))
        .limit(1)
    )[0];
    return {
      id: row.connection.id,
      createdAt: row.connection.createdAt.toISOString(),
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
    await this.expirePending();
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
      this.db
        .select()
        .from(candidateRecommendations)
        .where(
          inArray(
            candidateRecommendations.id,
            requests.map((request) => request.recommendationId),
          ),
        ),
      this.db
        .select()
        .from(members)
        .where(
          inArray(
            members.id,
            requests.flatMap((request) => [
              request.requesterMemberId,
              request.recipientMemberId,
            ]),
          ),
        ),
      this.db
        .select({
          anonymousCode: conversations.anonymousCode,
          contactRequestId: conversations.contactRequestId,
          id: conversations.id,
        })
        .from(conversations)
        .where(
          and(
            inArray(
              conversations.contactRequestId,
              requests.map((request) => request.id),
            ),
            isNotNull(conversations.recommendationId),
          ),
        ),
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
          reason: recommendation.reason,
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
