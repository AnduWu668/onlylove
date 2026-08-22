import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import type { ModerationConnections } from "../connections/moderation.js";
import type { ModerationConversations } from "../conversations/moderation.js";
import type { ModerationMatching } from "../matching/moderation.js";
import type { Mailer } from "../members/mailer.js";
import {
  PERMANENT_BAN_UNTIL,
  type ModerationMembers,
} from "../members/moderation.js";
import {
  distortionFeedback,
  memberBlocks,
  memberRecommendationRestrictions,
  moderationCaseAccessAudits,
  moderationCases,
  moderationDecisions,
  moderationNotificationOutbox,
  type ModerationAction,
  type ModerationTargetKind,
} from "./schema.js";

export class ModerationError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 409,
  ) {
    super(code);
  }
}

type ResolvedTarget = {
  reportedMemberId: string;
  messageId?: string;
  conversationId?: string;
};

function publicCase(value: typeof moderationCases.$inferSelect) {
  return {
    id: value.id,
    type: value.type,
    targetKind: value.targetKind,
    targetId: value.targetId,
    reason: value.reason,
    evidence: value.evidence,
    status: value.status,
    originalCaseId: value.originalCaseId,
    createdAt: value.createdAt.toISOString(),
    resolvedAt: value.resolvedAt?.toISOString() ?? null,
  };
}

function publicCaseSummary(value: typeof moderationCases.$inferSelect) {
  return {
    id: value.id,
    type: value.type,
    targetKind: value.targetKind,
    reason: value.reason,
    status: value.status,
    originalCaseId: value.originalCaseId,
    createdAt: value.createdAt.toISOString(),
    resolvedAt: value.resolvedAt?.toISOString() ?? null,
  };
}

function publicDecision(value: typeof moderationDecisions.$inferSelect) {
  return {
    action: value.action,
    reason: value.reason,
    suspendedUntil: value.suspendedUntil?.toISOString() ?? null,
    createdAt: value.createdAt.toISOString(),
  };
}

function actionLabel(action: ModerationAction, suspendedUntil: Date | null) {
  switch (action) {
    case "dismissed":
      return "驳回";
    case "warning":
      return "警告";
    case "suspended":
      return `限期停用至 ${suspendedUntil?.toISOString() ?? "指定日期"}`;
    case "banned":
      return "永久封禁";
  }
}

export class Moderation {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date,
    private readonly mailer: Mailer,
    private readonly conversations: ModerationConversations,
    private readonly connections: ModerationConnections,
    private readonly matching: ModerationMatching,
    private readonly members: ModerationMembers,
  ) {}

  private async resolveTarget(
    memberId: string,
    kind: ModerationTargetKind,
    targetId: string,
    database: Database | DatabaseTransaction,
  ): Promise<ResolvedTarget | undefined> {
    if (kind === "recommendation") {
      const reportedMemberId = await this.matching.recommendationTarget(
        memberId,
        targetId,
        database,
      );
      return reportedMemberId ? { reportedMemberId } : undefined;
    }
    if (kind === "contact_request" || kind === "connection") {
      const reportedMemberId = await this.connections.target(
        memberId,
        kind,
        targetId,
        database,
      );
      return reportedMemberId ? { reportedMemberId } : undefined;
    }
    return this.conversations.messageTarget(memberId, targetId, kind, database);
  }

  private async blockResolved(
    blockerMemberId: string,
    blockedMemberId: string,
    createdAt: Date,
    transaction: DatabaseTransaction,
  ) {
    if (blockerMemberId === blockedMemberId) {
      throw new ModerationError("MODERATION_TARGET_NOT_FOUND", 404);
    }
    const created = await transaction
      .insert(memberBlocks)
      .values({ blockerMemberId, blockedMemberId, createdAt })
      .onConflictDoNothing()
      .returning({ blockerMemberId: memberBlocks.blockerMemberId });
    await this.connections.endBetween(
      blockerMemberId,
      blockedMemberId,
      createdAt,
      transaction,
    );
    return created.length > 0;
  }

  async feedback(memberId: string, messageId: string, details: string) {
    const createdAt = this.now();
    return this.db.transaction(async (transaction) => {
      const target = await this.conversations.messageTarget(
        memberId,
        messageId,
        "twin_message",
        transaction,
      );
      if (!target) throw new ModerationError("TWIN_MESSAGE_NOT_FOUND", 404);
      const created = await transaction
        .insert(distortionFeedback)
        .values({
          id: randomUUID(),
          reporterMemberId: memberId,
          twinOwnerMemberId: target.reportedMemberId,
          messageId,
          details,
          createdAt,
        })
        .onConflictDoNothing()
        .returning();
      const feedback =
        created[0] ??
        (
          await transaction
            .select()
            .from(distortionFeedback)
            .where(
              and(
                eq(distortionFeedback.reporterMemberId, memberId),
                eq(distortionFeedback.messageId, messageId),
              ),
            )
            .limit(1)
        )[0]!;
      return {
        created: created.length > 0,
        feedback: {
          id: feedback.id,
          messageId: feedback.messageId,
          details: feedback.details,
          createdAt: feedback.createdAt.toISOString(),
        },
      };
    });
  }

  async block(
    memberId: string,
    kind: "recommendation" | "contact_request" | "connection",
    targetId: string,
  ) {
    const createdAt = this.now();
    return this.db.transaction(async (transaction) => {
      const target = await this.resolveTarget(memberId, kind, targetId, transaction);
      if (!target) throw new ModerationError("MODERATION_TARGET_NOT_FOUND", 404);
      const created = await this.blockResolved(
        memberId,
        target.reportedMemberId,
        createdAt,
        transaction,
      );
      return { created };
    });
  }

  async report(
    reporterMemberId: string,
    input: {
      targetKind: ModerationTargetKind;
      targetId: string;
      reason: string;
      evidence: string;
      block: boolean;
    },
  ) {
    const createdAt = this.now();
    const result = await this.db.transaction(async (transaction) => {
      const target = await this.resolveTarget(
        reporterMemberId,
        input.targetKind,
        input.targetId,
        transaction,
      );
      if (!target || target.reportedMemberId === reporterMemberId) {
        throw new ModerationError("MODERATION_TARGET_NOT_FOUND", 404);
      }
      const moderationCase = (
        await transaction
          .insert(moderationCases)
          .values({
            id: randomUUID(),
            type: "report",
            reporterMemberId,
            reportedMemberId: target.reportedMemberId,
            targetKind: input.targetKind,
            targetId: input.targetId,
            messageId: target.messageId,
            conversationId: target.conversationId,
            reason: input.reason,
            evidence: input.evidence,
            status: "pending",
            createdAt,
          })
          .returning()
      )[0]!;
      if (input.block) {
        await this.blockResolved(
          reporterMemberId,
          target.reportedMemberId,
          createdAt,
          transaction,
        );
      }
      return moderationCase;
    });
    return { case: publicCase(result) };
  }

  async appeal(
    memberId: string,
    originalCaseId: string,
    reason: string,
    evidence: string,
  ) {
    const createdAt = this.now();
    return this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`moderation-case:${originalCaseId}`}))`,
      );
      const original = (
        await transaction
          .select({ case: moderationCases, decision: moderationDecisions })
          .from(moderationCases)
          .innerJoin(
            moderationDecisions,
            eq(moderationDecisions.caseId, moderationCases.id),
          )
          .where(
            and(
              eq(moderationCases.id, originalCaseId),
              eq(moderationCases.type, "report"),
              eq(moderationCases.reportedMemberId, memberId),
              eq(moderationCases.status, "resolved"),
            ),
          )
          .limit(1)
      )[0];
      if (!original || original.decision.action === "dismissed") {
        throw new ModerationError("CASE_NOT_APPEALABLE", 404);
      }
      const existing = (
        await transaction
          .select()
          .from(moderationCases)
          .where(eq(moderationCases.originalCaseId, originalCaseId))
          .limit(1)
      )[0];
      if (existing) return { created: false, case: publicCase(existing) };
      const appealCase = (
        await transaction
          .insert(moderationCases)
          .values({
            id: randomUUID(),
            type: "appeal",
            reporterMemberId: memberId,
            reportedMemberId: memberId,
            targetKind: original.case.targetKind,
            targetId: original.case.targetId,
            messageId: original.case.messageId,
            conversationId: original.case.conversationId,
            reason,
            evidence,
            status: "pending",
            originalCaseId,
            createdAt,
          })
          .returning()
      )[0]!;
      return { created: true, case: publicCase(appealCase) };
    });
  }

  async state(memberId: string) {
    const [member] = await this.members.byIds([memberId]);
    if (!member) throw new ModerationError("UNAUTHENTICATED", 401);
    const [feedback, submittedReports, received, appeals] = await Promise.all([
      this.db
        .select()
        .from(distortionFeedback)
        .where(eq(distortionFeedback.twinOwnerMemberId, memberId))
        .orderBy(desc(distortionFeedback.createdAt)),
      this.db
        .select()
        .from(moderationCases)
        .where(
          and(
            eq(moderationCases.reporterMemberId, memberId),
            eq(moderationCases.type, "report"),
          ),
        )
        .orderBy(desc(moderationCases.createdAt)),
      this.db
        .select({ case: moderationCases, decision: moderationDecisions })
        .from(moderationCases)
        .innerJoin(
          moderationDecisions,
          eq(moderationDecisions.caseId, moderationCases.id),
        )
        .where(eq(moderationCases.reportedMemberId, memberId))
        .orderBy(desc(moderationDecisions.createdAt)),
      this.db
        .select({ originalCaseId: moderationCases.originalCaseId })
        .from(moderationCases)
        .where(
          and(
            eq(moderationCases.type, "appeal"),
            eq(moderationCases.reporterMemberId, memberId),
          ),
        ),
    ]);
    const messages = await this.conversations.messagesByIds(
      feedback.map(({ messageId }) => messageId),
    );
    const messageById = new Map(messages.map((message) => [message.id, message]));
    const appealed = new Set(
      appeals.flatMap(({ originalCaseId }) =>
        originalCaseId ? [originalCaseId] : [],
      ),
    );
    return {
      accessRestricted: Boolean(
        member.suspendedUntil && member.suspendedUntil > this.now(),
      ),
      permanentlyBanned:
        member.suspendedUntil?.getTime() === PERMANENT_BAN_UNTIL.getTime(),
      suspendedUntil: member.suspendedUntil?.toISOString() ?? null,
      receivedFeedback: feedback.flatMap((item) => {
        const message = messageById.get(item.messageId);
        return message
          ? [
              {
                id: item.id,
                details: item.details,
                createdAt: item.createdAt.toISOString(),
                message: {
                  id: message.id,
                  content: message.content,
                  createdAt: message.createdAt.toISOString(),
                },
                correctionPrompt:
                  "候选指出这条分身回答可能不准确，请通过理解纠正补充真实语境。",
              },
            ]
          : [];
      }),
      submittedReports: submittedReports.map((item) => ({
        id: item.id,
        status: item.status,
        outcome: item.status === "resolved" ? "processed" : "pending",
        createdAt: item.createdAt.toISOString(),
      })),
      receivedDecisions: received.map(({ case: item, decision }) => ({
        caseId: item.id,
        caseType: item.type,
        originalCaseId: item.originalCaseId,
        ...publicDecision(decision),
        canAppeal:
          item.type === "report" &&
          decision.action !== "dismissed" &&
          !appealed.has(item.id),
      })),
    };
  }

  async purgeMemberData(memberId: string, database: DatabaseTransaction) {
    const caseIds = (
      await database
        .select({ id: moderationCases.id })
        .from(moderationCases)
        .where(
          or(
            eq(moderationCases.reporterMemberId, memberId),
            eq(moderationCases.reportedMemberId, memberId),
          ),
        )
    ).map(({ id }) => id);
    await database
      .delete(moderationNotificationOutbox)
      .where(
        or(
          eq(moderationNotificationOutbox.recipientMemberId, memberId),
          caseIds.length
            ? inArray(moderationNotificationOutbox.caseId, caseIds)
            : undefined,
        ),
      );
    await database
      .delete(memberRecommendationRestrictions)
      .where(
        or(
          eq(memberRecommendationRestrictions.memberId, memberId),
          caseIds.length
            ? inArray(memberRecommendationRestrictions.sourceCaseId, caseIds)
            : undefined,
        ),
      );
    if (caseIds.length) {
      await database
        .delete(moderationCaseAccessAudits)
        .where(inArray(moderationCaseAccessAudits.caseId, caseIds));
      await database
        .delete(moderationDecisions)
        .where(inArray(moderationDecisions.caseId, caseIds));
      await database
        .delete(moderationCases)
        .where(inArray(moderationCases.id, caseIds));
    }
    await database
      .delete(distortionFeedback)
      .where(
        or(
          eq(distortionFeedback.reporterMemberId, memberId),
          eq(distortionFeedback.twinOwnerMemberId, memberId),
        ),
      );
    await database
      .delete(memberBlocks)
      .where(
        or(
          eq(memberBlocks.blockerMemberId, memberId),
          eq(memberBlocks.blockedMemberId, memberId),
        ),
      );
  }

  async metrics() {
    const [feedback, openCases] = await Promise.all([
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(distortionFeedback),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(moderationCases)
        .where(eq(moderationCases.status, "pending")),
    ]);
    return {
      distortionFeedbackCount: feedback[0]?.count ?? 0,
      openCaseCount: openCases[0]?.count ?? 0,
    };
  }

  async cases() {
    const rows = await this.db
      .select()
      .from(moderationCases)
      .orderBy(asc(moderationCases.status), asc(moderationCases.createdAt));
    return { cases: rows.map(publicCaseSummary) };
  }

  async caseDetail(caseId: string, actorMemberId: string) {
    return this.db.transaction(async (transaction) => {
      const row = (
        await transaction
        .select()
        .from(moderationCases)
        .where(eq(moderationCases.id, caseId))
        .limit(1)
      )[0];
      if (!row) throw new ModerationError("CASE_NOT_FOUND", 404);
      await transaction.insert(moderationCaseAccessAudits).values({
        id: randomUUID(),
        caseId,
        actorMemberId,
        createdAt: this.now(),
      });
      const decision = (
        await transaction
        .select()
        .from(moderationDecisions)
        .where(eq(moderationDecisions.caseId, caseId))
        .limit(1)
      )[0];
      return {
        case: publicCase(row),
        decision: decision ? publicDecision(decision) : null,
        chat: row.conversationId
          ? await this.conversations.chat(row.conversationId, transaction)
          : null,
      };
    });
  }

  async accessAudits() {
    const rows = await this.db
      .select()
      .from(moderationCaseAccessAudits)
      .orderBy(desc(moderationCaseAccessAudits.createdAt));
    return {
      audits: rows.map((row) => ({
        id: row.id,
        caseId: row.caseId,
        actorMemberId: row.actorMemberId,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  async decide(
    caseId: string,
    decidedByMemberId: string,
    input: {
      action: ModerationAction;
      reason: string;
      suspendedUntil?: Date;
    },
  ) {
    const decidedAt = this.now();
    if (
      input.action === "suspended" &&
      (!input.suspendedUntil || input.suspendedUntil <= decidedAt)
    ) {
      throw new ModerationError("INVALID_SUSPENSION_DATE", 400);
    }
    if (input.action !== "suspended" && input.suspendedUntil) {
      throw new ModerationError("UNEXPECTED_SUSPENSION_DATE", 400);
    }
    const result = await this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`moderation-case:${caseId}`}))`,
      );
      const current = (
        await transaction
          .select()
          .from(moderationCases)
          .where(eq(moderationCases.id, caseId))
          .limit(1)
      )[0];
      if (!current) throw new ModerationError("CASE_NOT_FOUND", 404);
      if (current.status !== "pending") {
        throw new ModerationError("CASE_ALREADY_RESOLVED");
      }
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`moderation-member:${current.reportedMemberId}`}))`,
      );
      const decision = (
        await transaction
          .insert(moderationDecisions)
          .values({
            caseId,
            decidedByMemberId,
            action: input.action,
            reason: input.reason,
            suspendedUntil: input.suspendedUntil,
            createdAt: decidedAt,
          })
          .returning()
      )[0]!;
      const resolved = (
        await transaction
          .update(moderationCases)
          .set({ status: "resolved", resolvedAt: decidedAt })
          .where(eq(moderationCases.id, caseId))
          .returning()
      )[0]!;
      const punitive = input.action === "suspended" || input.action === "banned";
      if (current.type === "appeal") {
        if (!current.originalCaseId) {
          throw new ModerationError("INVALID_APPEAL_CASE", 500);
        }
        await transaction
          .delete(memberRecommendationRestrictions)
          .where(
            and(
              eq(
                memberRecommendationRestrictions.memberId,
                current.reportedMemberId,
              ),
              eq(
                memberRecommendationRestrictions.sourceCaseId,
                current.originalCaseId,
              ),
            ),
          );
      }
      if (punitive) {
        await transaction
          .insert(memberRecommendationRestrictions)
          .values({
            memberId: current.reportedMemberId,
            sourceCaseId: caseId,
            createdAt: decidedAt,
          })
          .onConflictDoNothing();
        await this.connections.endForMember(
          current.reportedMemberId,
          decidedAt,
          transaction,
        );
      }
      if (current.type === "appeal" || punitive) {
        const activeDecisions = await transaction
          .select({
            action: moderationDecisions.action,
            suspendedUntil: moderationDecisions.suspendedUntil,
          })
          .from(memberRecommendationRestrictions)
          .innerJoin(
            moderationDecisions,
            eq(
              moderationDecisions.caseId,
              memberRecommendationRestrictions.sourceCaseId,
            ),
          )
          .where(
            eq(
              memberRecommendationRestrictions.memberId,
              current.reportedMemberId,
            ),
          );
        const suspendedUntil = activeDecisions.reduce<Date | null>(
          (latest, item) => {
            const candidate =
              item.action === "banned"
                ? PERMANENT_BAN_UNTIL
                : item.suspendedUntil;
            return candidate && (!latest || candidate > latest) ? candidate : latest;
          },
          null,
        );
        await this.members.setSuspension(
          current.reportedMemberId,
          suspendedUntil,
          transaction,
        );
      }
      const people = await this.members.byIds(
        [current.reporterMemberId, current.reportedMemberId],
        transaction,
      );
      const byId = new Map(people.map((member) => [member.id, member]));
      const reporter = byId.get(current.reporterMemberId)!;
      const reported = byId.get(current.reportedMemberId)!;
      const notifications: Array<typeof moderationNotificationOutbox.$inferInsert> = [
        {
          id: randomUUID(),
          caseId,
          recipientMemberId: reported.id,
          email: reported.email,
          disclosure: "reported" as const,
          message: `审核决定：${
            current.type === "appeal" && decision.action === "dismissed"
              ? "撤销原处置"
              : actionLabel(decision.action, decision.suspendedUntil)
          }。理由：${decision.reason}`,
          createdAt: decidedAt,
        },
      ];
      if (reporter.id !== reported.id) {
        notifications.push({
          id: randomUUID(),
          caseId,
          recipientMemberId: reporter.id,
          email: reporter.email,
          disclosure: "reporter",
          message: "你提交的举报案件已处理。出于隐私保护，通知不披露对方的具体处置。",
          createdAt: decidedAt,
        });
      }
      await transaction.insert(moderationNotificationOutbox).values(notifications);
      return { case: publicCase(resolved), decision: publicDecision(decision) };
    });
    await this.flushNotifications();
    return result;
  }

  async flushNotifications() {
    const send = this.mailer.sendModerationDecision?.bind(this.mailer);
    if (!send) return;
    await this.db.transaction(async (transaction) => {
      // ponytail: one DB-wide sender lock fits MVP volume; use leased claims if throughput grows.
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext('moderation-notifications'))`,
      );
      const pending = await transaction
        .select()
        .from(moderationNotificationOutbox)
        .where(isNull(moderationNotificationOutbox.sentAt))
        .orderBy(asc(moderationNotificationOutbox.createdAt));
      for (const notification of pending) {
        try {
          await send(
            notification.email,
            notification.message,
            notification.disclosure,
          );
          await transaction
            .update(moderationNotificationOutbox)
            .set({ sentAt: this.now() })
            .where(eq(moderationNotificationOutbox.id, notification.id));
        } catch {
          // The outbox remains pending for the next application start or action.
        }
      }
    });
  }
}
