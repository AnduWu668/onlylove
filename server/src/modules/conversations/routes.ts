import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  or,
  sql,
} from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import { AgentEngine, AgentRunError } from "../agent-engine/engine.js";
import { type AgentJob, AgentJobs } from "../agent-engine/jobs.js";
import {
  currentConnectionMembers,
  memberConnections,
} from "../connections/schema.js";
import {
  activeAdminById,
  adminForRequest,
  candidatePublicProfileById,
  interviewContextForMember,
  memberForRequest,
  publicProfile,
  superAdminForRequest,
} from "../members/routes.js";
import { members } from "../members/schema.js";
import { memberBlocks } from "../moderation/schema.js";
import {
  agentQuotaSettings,
  agentQuotaSettingsAudits,
  candidateTwinDailyQuotas,
  conversationMessages,
  conversations,
  ownAgentDailyQuotas,
} from "./schema.js";
import type { Portraits } from "../portraits/service.js";

const DEFAULT_OWN_AGENT_DAILY_LIMIT = 100;
const DEFAULT_CANDIDATE_TWIN_DAILY_LIMIT = 50;
const JOB_LEASE_MS = 2 * 60 * 1_000;
const JOB_HEARTBEAT_MS = 30 * 1_000;

export interface ConversationsOptions {
  db: Database;
  agentEngine: AgentEngine;
  agentJobs: AgentJobs;
  candidateForTwinConversation: (
    memberId: string,
    recommendationId: string,
    candidateMemberId?: string,
    transaction?: DatabaseTransaction,
  ) => Promise<string | undefined>;
  requesterForTwinConversation: (
    memberId: string,
    contactRequestId: string,
    requesterMemberId?: string,
    transaction?: DatabaseTransaction,
  ) => Promise<string | undefined>;
  now: () => Date;
  portraits: Portraits;
}

function beijingDate(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function publicMessage(message: typeof conversationMessages.$inferSelect) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
  };
}

function publicHumanMessage(
  message: typeof conversationMessages.$inferSelect,
  viewerMemberId: string,
) {
  return {
    id: message.id,
    sender: message.senderMemberId === viewerMemberId ? "self" : "other",
    content: message.content,
    sequence: message.sequence,
    createdAt: message.createdAt.toISOString(),
  };
}

async function humanConversationForMember(
  database: Database | DatabaseTransaction,
  conversationId: string,
  memberId: string,
) {
  return (
    await database
      .select({ conversation: conversations, connection: memberConnections })
      .from(conversations)
      .innerJoin(
        memberConnections,
        eq(conversations.connectionId, memberConnections.id),
      )
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.type, "HUMAN"),
          or(
            eq(conversations.memberId, memberId),
            eq(conversations.visitorMemberId, memberId),
          ),
        ),
      )
      .limit(1)
  )[0];
}

async function humanConversationCanSend(
  database: Database | DatabaseTransaction,
  state: NonNullable<Awaited<ReturnType<typeof humanConversationForMember>>>,
  at: Date,
) {
  if (state.connection.status !== "active") return false;
  const memberIds = [
    state.connection.memberAId,
    state.connection.memberBId,
  ];
  const currentMembers = await database
    .select({ memberId: currentConnectionMembers.memberId })
    .from(currentConnectionMembers)
    .where(
      and(
        eq(currentConnectionMembers.connectionId, state.connection.id),
        inArray(currentConnectionMembers.memberId, memberIds),
      ),
    );
  const participantRows = await database
    .select({
      id: members.id,
      role: members.role,
      deletedAt: members.deletedAt,
      suspendedUntil: members.suspendedUntil,
    })
    .from(members)
    .where(inArray(members.id, memberIds));
  const blocked = await database
    .select({ blockerMemberId: memberBlocks.blockerMemberId })
    .from(memberBlocks)
    .where(
      or(
        and(
          eq(memberBlocks.blockerMemberId, memberIds[0]!),
          eq(memberBlocks.blockedMemberId, memberIds[1]!),
        ),
        and(
          eq(memberBlocks.blockerMemberId, memberIds[1]!),
          eq(memberBlocks.blockedMemberId, memberIds[0]!),
        ),
      ),
    )
    .limit(1);
  return (
    currentMembers.length === 2 &&
    participantRows.length === 2 &&
    participantRows.every(
      (member) =>
        member.role === "member" &&
        !member.deletedAt &&
        (!member.suspendedUntil || member.suspendedUntil <= at),
    ) &&
    !blocked.length
  );
}

async function humanConversationState(
  options: ConversationsOptions,
  conversationId: string,
  viewerMemberId: string,
) {
  const state = await humanConversationForMember(
    options.db,
    conversationId,
    viewerMemberId,
  );
  if (!state) return undefined;
  const messagesInConversation = await options.db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversationId))
    .orderBy(asc(conversationMessages.sequence));
  const lastSequence = messagesInConversation.at(-1)?.sequence ?? 0;
  const viewerIsMember = state.conversation.memberId === viewerMemberId;
  const lastReadSequence = viewerIsMember
    ? state.conversation.memberLastReadSequence
    : state.conversation.visitorLastReadSequence;
  if (lastSequence > lastReadSequence) {
    await options.db
      .update(conversations)
      .set(
        viewerIsMember
          ? { memberLastReadSequence: lastSequence }
          : { visitorLastReadSequence: lastSequence },
      )
      .where(eq(conversations.id, conversationId));
  }
  const otherMemberId = viewerIsMember
    ? state.conversation.visitorMemberId!
    : state.conversation.memberId;
  const otherMember = (
    await options.db
      .select({ nickname: members.nickname, deletedAt: members.deletedAt })
      .from(members)
      .where(eq(members.id, otherMemberId))
      .limit(1)
  )[0]!;
  return {
    conversationId,
    createdAt: state.conversation.createdAt.toISOString(),
    canSend: await humanConversationCanSend(options.db, state, options.now()),
    otherMember: otherMember.deletedAt
      ? {
          displayName: "已注销成员（历史消息已保留）",
          deleted: true,
        }
      : {
          displayName: otherMember.nickname ?? "联系成员",
          deleted: false,
        },
    messages: messagesInConversation.map((message) =>
      publicHumanMessage(message, viewerMemberId),
    ),
    unreadCount: 0,
    eventsUrl: `/api/member/human-conversations/${conversationId}/events?after=${lastSequence}`,
  };
}

async function reserveHumanMessage(
  options: ConversationsOptions,
  input: {
    conversationId: string;
    memberId: string;
    clientMessageId: string;
    content: string;
    submittedAt: Date;
  },
) {
  return options.db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${input.conversationId}))`,
    );
    const state = await humanConversationForMember(
      transaction,
      input.conversationId,
      input.memberId,
    );
    if (!state) return { notFound: true as const };
    const duplicate = (
      await transaction
        .select()
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.conversationId, input.conversationId),
            eq(
              conversationMessages.clientMessageId,
              input.clientMessageId,
            ),
          ),
        )
        .limit(1)
    )[0];
    if (duplicate) {
      return { created: false as const, message: duplicate };
    }
    if (!(await humanConversationCanSend(transaction, state, input.submittedAt))) {
      return { readOnly: true as const };
    }
    const lastSequence = (
      await transaction
        .select({ value: max(conversationMessages.sequence) })
        .from(conversationMessages)
        .where(
          eq(conversationMessages.conversationId, input.conversationId),
        )
    )[0]?.value;
    const message = (
      await transaction
        .insert(conversationMessages)
        .values({
          id: randomUUID(),
          conversationId: input.conversationId,
          role: "member",
          content: input.content,
          sequence: (lastSequence ?? 0) + 1,
          clientMessageId: input.clientMessageId,
          senderMemberId: input.memberId,
          createdAt: input.submittedAt,
        })
        .returning()
    )[0]!;
    return { created: true as const, message };
  });
}

async function loadAgentQuotaSettings(
  database: Database | DatabaseTransaction,
  at: Date,
) {
  await database
    .insert(agentQuotaSettings)
    .values({
      id: 1,
      ownAgentDailyLimit: DEFAULT_OWN_AGENT_DAILY_LIMIT,
      candidateTwinDailyLimit: DEFAULT_CANDIDATE_TWIN_DAILY_LIMIT,
      updatedAt: at,
    })
    .onConflictDoNothing();
  return (
    await database
      .select()
      .from(agentQuotaSettings)
      .where(eq(agentQuotaSettings.id, 1))
      .limit(1)
  )[0]!;
}

async function processConversationAgentJob(
  stream: PassThrough,
  job: AgentJob,
  memberContext: Awaited<ReturnType<typeof interviewContextForMember>>,
  options: ConversationsOptions,
) {
  const { agentEngine, agentJobs, db, now, portraits } = options;
  if (
    !["continue_interview", "reply_as_twin"].includes(job.task) ||
    !job.conversationId ||
    !job.inputMessageId
  ) {
    stream.end(sse("error", { code: "AGENT_JOB_NOT_AVAILABLE" }));
    return;
  }
  const startedAt = now();
  const claimed = await agentJobs.claim(
    job.id,
    startedAt,
    new Date(startedAt.getTime() + JOB_LEASE_MS),
  );

  if (!claimed) {
    const current = await agentJobs.get(job.id);
    if (current?.status === "completed") {
      const answer = current.outputMessageId
        ? (
            await db
              .select()
              .from(conversationMessages)
              .where(eq(conversationMessages.id, current.outputMessageId))
              .limit(1)
          )[0]
        : undefined;
      if (answer) stream.write(sse("delta", { text: answer.content }));
      stream.end(sse("done", { messageId: answer?.id }));
      return;
    }
    if (current?.status === "failed") {
      stream.end(sse("error", { code: current.error ?? "AGENT_JOB_FAILED" }));
      return;
    }
    stream.end("retry: 1000\n\n");
    return;
  }
  if (!claimed.conversationId || !claimed.inputMessageId) {
    stream.end(sse("error", { code: "AGENT_JOB_NOT_AVAILABLE" }));
    return;
  }
  const conversationId = claimed.conversationId;
  const inputMessageId = claimed.inputMessageId;

  const heartbeat = setInterval(() => {
    const at = now();
    void agentJobs.heartbeat(
      claimed,
      new Date(at.getTime() + JOB_LEASE_MS),
    ).catch(() => undefined);
  }, JOB_HEARTBEAT_MS);
  heartbeat.unref();

  let retryCount = 0;
  let switchedModel = false;
  let modelCompleted = false;
  let input: typeof conversationMessages.$inferSelect | undefined;
  let conversation: typeof conversations.$inferSelect | undefined;

  try {
    input = (
      await db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.id, inputMessageId))
        .limit(1)
    )[0]!;
    conversation = (
      await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1)
    )[0];
    if (!conversation) throw new AgentRunError("TWIN_CONTEXT_NOT_AVAILABLE");
    const candidateTwin = Boolean(conversation.visitorMemberId);
    if (candidateTwin && claimed.task !== "reply_as_twin") {
      throw new AgentRunError("AGENT_JOB_NOT_AVAILABLE");
    }
    const recentHistory = await db
      .select({
        role: conversationMessages.role,
        content: conversationMessages.content,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, conversationId),
          lt(conversationMessages.sequence, input.sequence),
        ),
      )
      .orderBy(desc(conversationMessages.sequence))
      .limit(200);
    const history = recentHistory.reverse();
    const extraction = candidateTwin
      ? { newlyConfident: false, completed: 0 }
      : claimed.task === "continue_interview"
        ? await portraits.extractDraft(
            claimed.memberId,
            conversationId,
            input.sequence,
            agentEngine,
            (attempts) =>
              agentJobs.recordAttempts(
                claimed,
                attempts,
                now(),
                agentEngine.extractorDefinition,
              ),
          )
        : await portraits.absorbSelfTwinMessage(
            claimed.memberId,
            input.id,
            input.content,
            agentEngine,
            (attempts) =>
              agentJobs.recordAttempts(
                claimed,
                attempts,
                now(),
                agentEngine.extractorDefinition,
              ),
          );
    if (extraction.newlyConfident) {
      stream.write(
        sse("progress", {
          completed: extraction.completed,
          total: 8,
          feedback: "我对你的理解又清楚了一些",
        }),
      );
    }
    const result =
      claimed.task === "continue_interview"
        ? await agentEngine.continueInterview(
            {
              ...memberContext,
              ...(await portraits.draftForInterviewer(
                claimed.memberId,
                input.content,
              )),
              recentMessages: history,
            },
            input.content,
            (text) => stream.write(sse("delta", { text })),
            (attempts) => agentJobs.recordAttempts(claimed, attempts, now()),
          )
        : await (async () => {
            if (!claimed.profileVersionId) {
              throw new AgentRunError("TWIN_CONTEXT_NOT_AVAILABLE");
            }
            const context = await portraits.twinContext(
              conversation.memberId,
              claimed.profileVersionId,
            );
            if (!context) {
              throw new AgentRunError("TWIN_CONTEXT_NOT_AVAILABLE");
            }
            return agentEngine.replyAsTwin(
              {
                personaContext: context.personaContext,
                publicProfile: memberContext.memberProfile,
                recentMessages: history,
              },
              input.content,
              (text) => stream.write(sse("delta", { text })),
              (attempts) => agentJobs.recordAttempts(claimed, attempts, now()),
            );
          })();
    retryCount = result.retryCount;
    switchedModel = result.switchedModel;
    modelCompleted = true;
    const completedAt = now();
    const answer = await db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${conversationId}))`,
      );
      const lastSequence = (
        await transaction
          .select({ value: max(conversationMessages.sequence) })
          .from(conversationMessages)
          .where(eq(conversationMessages.conversationId, conversationId))
      )[0]?.value;
      const answerId = randomUUID();
      const saved = (
        await transaction
          .insert(conversationMessages)
          .values({
            id: answerId,
            conversationId,
            role: "agent",
            content: result.text,
            sequence: (lastSequence ?? 0) + 1,
            createdAt: completedAt,
          })
          .returning()
      )[0]!;
      const completed = await agentJobs.complete(
        transaction,
        claimed,
        answerId,
        result.retryCount,
        result.switchedModel,
        completedAt,
      );
      if (!completed) throw new Error("AGENT_JOB_LEASE_LOST");
      return saved;
    });
    stream.end(sse("done", { messageId: answer.id }));
  } catch (error) {
    const code =
      error instanceof AgentRunError
        ? error.code
        : modelCompleted
          ? "JOB_WRITEBACK_FAILED"
          : "MODEL_REQUEST_FAILED";
    if (error instanceof AgentRunError) {
      retryCount = error.retryCount;
      switchedModel = error.switchedModel;
    }
    const failedAt = now();
    const refundQuota =
      Boolean(input?.clientMessageId) && !claimed.quotaRefunded;
    await db.transaction(async (transaction) => {
      const failed = await agentJobs.fail(
        transaction,
        claimed,
        code,
        retryCount,
        switchedModel,
        refundQuota,
        failedAt,
      );
      if (failed && refundQuota) {
        if (conversation?.visitorMemberId) {
          await transaction
            .update(candidateTwinDailyQuotas)
            .set({
              used: sql`${candidateTwinDailyQuotas.used} - 1`,
              updatedAt: failedAt,
            })
            .where(
              and(
                eq(candidateTwinDailyQuotas.memberId, claimed.memberId),
                eq(
                  candidateTwinDailyQuotas.quotaDate,
                  beijingDate(claimed.createdAt),
                ),
              ),
            );
        } else {
          await transaction
            .update(ownAgentDailyQuotas)
            .set({
              used: sql`${ownAgentDailyQuotas.used} - 1`,
              updatedAt: failedAt,
            })
            .where(
              and(
                eq(ownAgentDailyQuotas.memberId, claimed.memberId),
                eq(
                  ownAgentDailyQuotas.quotaDate,
                  beijingDate(claimed.createdAt),
                ),
              ),
            );
        }
      }
    });
    stream.end(sse("error", { code }));
  } finally {
    clearInterval(heartbeat);
  }
}

async function reserveOwnAgentMessage(
  options: ConversationsOptions,
  input: {
    memberId: string;
    type: "INTERVIEW" | "TWIN";
    clientMessageId: string;
    content: string;
    submittedAt: Date;
  },
) {
  const { agentEngine, agentJobs, db } = options;
  const quotaDate = beijingDate(input.submittedAt);
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${input.memberId}:${quotaDate}`}))`,
    );
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${input.memberId}))`,
    );
    const settings = await loadAgentQuotaSettings(transaction, input.submittedAt);
    const published =
      input.type === "TWIN"
        ? await options.portraits.twinContext(
            input.memberId,
            undefined,
            transaction,
          )
        : undefined;
    if (input.type === "TWIN" && !published) {
      throw new AgentRunError("TWIN_NOT_PUBLISHED");
    }
    await transaction
      .insert(conversations)
      .values({
        id: randomUUID(),
        type: input.type,
        memberId: input.memberId,
        profileVersionId: published?.profileVersion.id,
        createdAt: input.submittedAt,
      })
      .onConflictDoNothing();
    const conversation = (
      await transaction
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.memberId, input.memberId),
            eq(conversations.type, input.type),
            isNull(conversations.visitorMemberId),
          ),
        )
        .limit(1)
    )[0]!;
    if (input.type === "TWIN" && !conversation.profileVersionId) {
      throw new AgentRunError("TWIN_CONTEXT_NOT_AVAILABLE");
    }
    const duplicate = (
      await transaction
        .select()
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.conversationId, conversation.id),
            eq(conversationMessages.clientMessageId, input.clientMessageId),
          ),
        )
        .limit(1)
    )[0];
    const quota = (
      await transaction
        .select()
        .from(ownAgentDailyQuotas)
        .where(
          and(
            eq(ownAgentDailyQuotas.memberId, input.memberId),
            eq(ownAgentDailyQuotas.quotaDate, quotaDate),
          ),
        )
        .limit(1)
    )[0];
    if (duplicate) {
      const duplicateJob = await agentJobs.findByInput(
        transaction,
        duplicate.id,
      );
      if (!duplicateJob) throw new Error("AGENT_JOB_NOT_FOUND");
      return {
        conversation,
        job: duplicateJob,
        quotaRemaining: Math.max(
          0,
          settings.ownAgentDailyLimit - (quota?.used ?? 0),
        ),
      };
    }
    if (
      await agentJobs.findActiveForConversation(transaction, conversation.id)
    ) {
      return { inProgress: true as const };
    }
    if ((quota?.used ?? 0) >= settings.ownAgentDailyLimit) return undefined;
    if (quota) {
      await transaction
        .update(ownAgentDailyQuotas)
        .set({ used: quota.used + 1, updatedAt: input.submittedAt })
        .where(
          and(
            eq(ownAgentDailyQuotas.memberId, input.memberId),
            eq(ownAgentDailyQuotas.quotaDate, quotaDate),
          ),
        );
    } else {
      await transaction.insert(ownAgentDailyQuotas).values({
        memberId: input.memberId,
        quotaDate,
        used: 1,
        updatedAt: input.submittedAt,
      });
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
          content: input.content,
          sequence: (lastSequence ?? 0) + 1,
          clientMessageId: input.clientMessageId,
          createdAt: input.submittedAt,
        })
        .returning()
    )[0]!;
    const definition =
      input.type === "INTERVIEW"
        ? agentEngine.interviewerDefinition
        : agentEngine.twinDefinition;
    const job = await agentJobs.create(transaction, {
      id: randomUUID(),
      role: definition.role,
      task: definition.task,
      definitionVersion: definition.version,
      promptVersion: definition.promptVersion,
      schemaVersion: definition.schemaVersion,
      memberId: input.memberId,
      conversationId: conversation.id,
      inputMessageId: message.id,
      profileVersionId: conversation.profileVersionId,
      status: "pending",
      retryCount: 0,
      switchedModel: false,
      quotaRefunded: false,
      createdAt: input.submittedAt,
    });
    return {
      conversation,
      job,
      quotaRemaining: settings.ownAgentDailyLimit - (quota?.used ?? 0) - 1,
    };
  });
}

async function candidateConversationState(
  options: ConversationsOptions,
  conversation: typeof conversations.$inferSelect,
  viewer: "visitor" | "owner",
) {
  if (!conversation.profileVersionId) return undefined;
  const [pinned, messages, candidate, activeJob] = await Promise.all([
    options.portraits.twinContext(
      conversation.memberId,
      conversation.profileVersionId,
    ),
    options.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversation.id))
      .orderBy(asc(conversationMessages.sequence)),
    viewer === "visitor"
      ? candidatePublicProfileById(conversation.memberId, options.db)
      : undefined,
    viewer === "visitor"
      ? options.agentJobs.findActiveForConversationId(conversation.id)
      : undefined,
  ]);
  if (!pinned || (viewer === "visitor" && !candidate)) return undefined;
  return {
    conversationId: conversation.id,
    anonymousCode: conversation.anonymousCode,
    createdAt: conversation.createdAt.toISOString(),
    profileVersion: pinned.profileVersion,
    messages: messages.map(publicMessage),
    canReply: viewer === "visitor",
    ...(activeJob
      ? {
          autoFollowup: {
            jobId: activeJob.id,
            eventsUrl: `/api/member/candidate-twin-jobs/${activeJob.id}/events`,
          },
        }
      : {}),
    ...(candidate
      ? {
          candidate: {
            nickname: candidate.nickname,
            heightCm: candidate.heightCm,
            city: candidate.city,
            occupation: candidate.occupation,
          },
        }
      : {}),
  };
}

async function reserveCandidateTwinMessage(
  options: ConversationsOptions,
  input: {
    visitorMemberId: string;
    conversationId: string;
    clientMessageId: string;
    content: string;
    submittedAt: Date;
  },
) {
  const conversation = (
    await options.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.type, "TWIN"),
          eq(conversations.visitorMemberId, input.visitorMemberId),
        ),
      )
      .limit(1)
  )[0];
  if (!conversation?.recommendationId && !conversation?.contactRequestId) {
    return { notFound: true as const };
  }
  const quotaDate = beijingDate(input.submittedAt);
  return options.db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`candidate-twin:${input.visitorMemberId}:${quotaDate}`}))`,
    );
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${input.conversationId}))`,
    );
    const settings = await loadAgentQuotaSettings(transaction, input.submittedAt);
    const current = (
      await transaction
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.id, input.conversationId),
            eq(conversations.type, "TWIN"),
            eq(conversations.visitorMemberId, input.visitorMemberId),
          ),
        )
        .limit(1)
    )[0];
    if (
      !current?.profileVersionId ||
      (!current.recommendationId && !current.contactRequestId)
    ) {
      return { notFound: true as const };
    }
    const candidateAvailable = current.recommendationId
      ? await options.candidateForTwinConversation(
          input.visitorMemberId,
          current.recommendationId,
          current.memberId,
          transaction,
        )
      : await options.requesterForTwinConversation(
          input.visitorMemberId,
          current.contactRequestId!,
          current.memberId,
          transaction,
        );
    if (!candidateAvailable) {
      return { unavailable: true as const };
    }
    if (
      !(await options.portraits.twinContext(
        current.memberId,
        undefined,
        transaction,
      ))
    ) {
      return { unavailable: true as const };
    }
    const duplicate = (
      await transaction
        .select()
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.conversationId, current.id),
            eq(conversationMessages.clientMessageId, input.clientMessageId),
          ),
        )
        .limit(1)
    )[0];
    const quota = (
      await transaction
        .select()
        .from(candidateTwinDailyQuotas)
        .where(
          and(
            eq(candidateTwinDailyQuotas.memberId, input.visitorMemberId),
            eq(candidateTwinDailyQuotas.quotaDate, quotaDate),
          ),
        )
        .limit(1)
    )[0];
    if (duplicate) {
      const duplicateJob = await options.agentJobs.findByInput(
        transaction,
        duplicate.id,
      );
      if (!duplicateJob) throw new Error("AGENT_JOB_NOT_FOUND");
      return {
        conversation: current,
        job: duplicateJob,
        quotaRemaining: Math.max(
          0,
          settings.candidateTwinDailyLimit - (quota?.used ?? 0),
        ),
      };
    }
    if (
      await options.agentJobs.findActiveForConversation(transaction, current.id)
    ) {
      return { inProgress: true as const };
    }
    if ((quota?.used ?? 0) >= settings.candidateTwinDailyLimit) return undefined;
    if (quota) {
      await transaction
        .update(candidateTwinDailyQuotas)
        .set({ used: quota.used + 1, updatedAt: input.submittedAt })
        .where(
          and(
            eq(candidateTwinDailyQuotas.memberId, input.visitorMemberId),
            eq(candidateTwinDailyQuotas.quotaDate, quotaDate),
          ),
        );
    } else {
      await transaction.insert(candidateTwinDailyQuotas).values({
        memberId: input.visitorMemberId,
        quotaDate,
        used: 1,
        updatedAt: input.submittedAt,
      });
    }
    const lastSequence = (
      await transaction
        .select({ value: max(conversationMessages.sequence) })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, current.id))
    )[0]?.value;
    const message = (
      await transaction
        .insert(conversationMessages)
        .values({
          id: randomUUID(),
          conversationId: current.id,
          role: "member",
          content: input.content,
          sequence: (lastSequence ?? 0) + 1,
          clientMessageId: input.clientMessageId,
          createdAt: input.submittedAt,
        })
        .returning()
    )[0]!;
    const definition = options.agentEngine.twinDefinition;
    const job = await options.agentJobs.create(transaction, {
      id: randomUUID(),
      role: definition.role,
      task: definition.task,
      definitionVersion: definition.version,
      promptVersion: definition.promptVersion,
      schemaVersion: definition.schemaVersion,
      memberId: input.visitorMemberId,
      conversationId: current.id,
      inputMessageId: message.id,
      profileVersionId: current.profileVersionId,
      status: "pending",
      retryCount: 0,
      switchedModel: false,
      quotaRefunded: false,
      createdAt: input.submittedAt,
    });
    return {
      conversation: current,
      job,
      quotaRemaining:
        settings.candidateTwinDailyLimit - (quota?.used ?? 0) - 1,
    };
  });
}

export function registerConversationsRoutes(
  app: FastifyInstance,
  options: ConversationsOptions,
) {
  const { agentJobs, db, now } = options;
  const humanStreams = new Map<
    string,
    Set<{ memberId: string; stream: PassThrough }>
  >();

  app.addHook("onClose", async () => {
    for (const listeners of humanStreams.values()) {
      for (const { stream } of listeners) stream.end();
    }
    humanStreams.clear();
  });

  app.get<{ Params: { conversationId: string } }>(
    "/api/member/human-conversations/:conversationId",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["conversationId"],
          properties: { conversationId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const member = await memberForRequest(request, db, now());
      if (!member || member.role !== "member") {
        return reply.code(404).send({ code: "CONVERSATION_NOT_FOUND" });
      }
      const state = await humanConversationState(
        options,
        request.params.conversationId,
        member.id,
      );
      if (!state) {
        return reply.code(404).send({ code: "CONVERSATION_NOT_FOUND" });
      }
      return state;
    },
  );

  app.post<{
    Params: { conversationId: string };
    Body: { clientMessageId: string; content: string };
  }>(
    "/api/member/human-conversations/:conversationId/messages",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["conversationId"],
          properties: { conversationId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["clientMessageId", "content"],
          properties: {
            clientMessageId: { type: "string", format: "uuid" },
            content: { type: "string", minLength: 1, maxLength: 4_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const submittedAt = now();
      const member = await memberForRequest(request, db, submittedAt);
      if (!member || member.role !== "member") {
        return reply.code(404).send({ code: "CONVERSATION_NOT_FOUND" });
      }
      const content = request.body.content.trim();
      if (!content) return reply.code(400).send({ code: "EMPTY_MESSAGE" });
      const result = await reserveHumanMessage(options, {
        conversationId: request.params.conversationId,
        memberId: member.id,
        clientMessageId: request.body.clientMessageId,
        content,
        submittedAt,
      });
      if ("notFound" in result) {
        return reply.code(404).send({ code: "CONVERSATION_NOT_FOUND" });
      }
      if ("readOnly" in result) {
        return reply
          .code(409)
          .send({ code: "HUMAN_CONVERSATION_READ_ONLY" });
      }
      const message = publicHumanMessage(result.message, member.id);
      if (result.created) {
        for (const listener of humanStreams.get(
          request.params.conversationId,
        ) ?? []) {
          listener.stream.write(
            `id: ${result.message.sequence}\n${sse(
              "message",
              publicHumanMessage(result.message, listener.memberId),
            )}`,
          );
        }
      }
      return reply.code(result.created ? 201 : 200).send({ message });
    },
  );

  app.post<{
    Params: { conversationId: string };
    Body: { lastReadSequence: number };
  }>(
    "/api/member/human-conversations/:conversationId/read",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["conversationId"],
          properties: { conversationId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["lastReadSequence"],
          properties: { lastReadSequence: { type: "integer", minimum: 0 } },
        },
      },
    },
    async (request, reply) => {
      const member = await memberForRequest(request, db, now());
      if (!member || member.role !== "member") {
        return reply.code(404).send({ code: "CONVERSATION_NOT_FOUND" });
      }
      const state = await humanConversationForMember(
        db,
        request.params.conversationId,
        member.id,
      );
      if (!state) {
        return reply.code(404).send({ code: "CONVERSATION_NOT_FOUND" });
      }
      const lastSequence =
        (
          await db
            .select({ value: max(conversationMessages.sequence) })
            .from(conversationMessages)
            .where(
              eq(
                conversationMessages.conversationId,
                request.params.conversationId,
              ),
            )
        )[0]?.value ?? 0;
      const readThrough = Math.min(request.body.lastReadSequence, lastSequence);
      const viewerIsMember = state.conversation.memberId === member.id;
      await db
        .update(conversations)
        .set(
          viewerIsMember
            ? {
                memberLastReadSequence: sql`greatest(${conversations.memberLastReadSequence}, ${readThrough})`,
              }
            : {
                visitorLastReadSequence: sql`greatest(${conversations.visitorLastReadSequence}, ${readThrough})`,
              },
        )
        .where(eq(conversations.id, request.params.conversationId));
      return reply.code(204).send();
    },
  );

  app.get<{
    Params: { conversationId: string };
    Querystring: { after: number };
  }>(
    "/api/member/human-conversations/:conversationId/events",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["conversationId"],
          properties: { conversationId: { type: "string", format: "uuid" } },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["after"],
          properties: { after: { type: "integer", minimum: 0 } },
        },
      },
    },
    async (request, reply) => {
      const member = await memberForRequest(request, db, now());
      if (
        !member ||
        member.role !== "member" ||
        !(await humanConversationForMember(
          db,
          request.params.conversationId,
          member.id,
        ))
      ) {
        return reply.code(404).send({ code: "CONVERSATION_NOT_FOUND" });
      }
      const stream = new PassThrough();
      const listener = { memberId: member.id, stream };
      const listeners = humanStreams.get(request.params.conversationId) ?? new Set();
      listeners.add(listener);
      humanStreams.set(request.params.conversationId, listeners);
      const cleanup = () => {
        listeners.delete(listener);
        if (!listeners.size) humanStreams.delete(request.params.conversationId);
      };
      reply.raw.once("close", cleanup);
      stream.once("close", cleanup);
      reply.headers({
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      stream.write("retry: 1000\n\n");
      const waiting = await db
        .select()
        .from(conversationMessages)
        .where(
          and(
            eq(
              conversationMessages.conversationId,
              request.params.conversationId,
            ),
            gt(conversationMessages.sequence, request.query.after),
          ),
        )
        .orderBy(asc(conversationMessages.sequence));
      for (const message of waiting) {
        stream.write(
          `id: ${message.sequence}\n${sse(
            "message",
            publicHumanMessage(message, member.id),
          )}`,
        );
      }
      return reply.send(stream);
    },
  );

  app.get("/api/admin/agent-quota-settings", async (request, reply) => {
    const actor = await superAdminForRequest(request, db, now());
    if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
    const settings = await loadAgentQuotaSettings(db, now());
    return {
      ownAgentDailyLimit: settings.ownAgentDailyLimit,
      candidateTwinDailyLimit: settings.candidateTwinDailyLimit,
    };
  });

  app.put<{
    Body: { ownAgentDailyLimit: number; candidateTwinDailyLimit: number };
  }>(
    "/api/admin/agent-quota-settings",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["ownAgentDailyLimit", "candidateTwinDailyLimit"],
          properties: {
            ownAgentDailyLimit: { type: "integer", minimum: 1, maximum: 10_000 },
            candidateTwinDailyLimit: {
              type: "integer",
              minimum: 1,
              maximum: 10_000,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = await superAdminForRequest(request, db, now());
      if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
      const updatedAt = now();
      const settings = await db.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext('agent-quota-settings'))`,
        );
        const current = await loadAgentQuotaSettings(transaction, updatedAt);
        const updated = (
          await transaction
            .update(agentQuotaSettings)
            .set({ ...request.body, updatedBy: actor.id, updatedAt })
            .where(eq(agentQuotaSettings.id, 1))
            .returning()
        )[0]!;
        await transaction.insert(agentQuotaSettingsAudits).values({
          id: randomUUID(),
          actorId: actor.id,
          previousOwnAgentDailyLimit: current.ownAgentDailyLimit,
          previousCandidateTwinDailyLimit: current.candidateTwinDailyLimit,
          ...request.body,
          createdAt: updatedAt,
        });
        return updated;
      });
      return {
        ownAgentDailyLimit: settings.ownAgentDailyLimit,
        candidateTwinDailyLimit: settings.candidateTwinDailyLimit,
      };
    },
  );

  app.get("/api/admin/agent-quota-settings/audit", async (request, reply) => {
    const actor = await superAdminForRequest(request, db, now());
    if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
    return {
      audits: await db
        .select()
        .from(agentQuotaSettingsAudits)
        .orderBy(desc(agentQuotaSettingsAudits.createdAt)),
    };
  });

  app.post<{
    Params: { id: string };
    Body: { consentToOwnerVisibility: true };
  }>(
    "/api/member/recommendations/:id/twin-conversation",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["consentToOwnerVisibility"],
          properties: { consentToOwnerVisibility: { type: "boolean", const: true } },
        },
      },
    },
    async (request, reply) => {
      const openedAt = now();
      const member = await memberForRequest(request, db, openedAt);
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      const candidateMemberId = await options.candidateForTwinConversation(
        member.id,
        request.params.id,
      );
      if (!candidateMemberId) {
        return reply.code(404).send({ code: "RECOMMENDATION_NOT_FOUND" });
      }
      const result = await db.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`${member.id}:${request.params.id}`}))`,
        );
        if (
          !(await options.candidateForTwinConversation(
            member.id,
            request.params.id,
            candidateMemberId,
            transaction,
          ))
        ) {
          return undefined;
        }
        const existing = (
          await transaction
            .select()
            .from(conversations)
            .where(
              and(
                eq(conversations.visitorMemberId, member.id),
                eq(conversations.recommendationId, request.params.id),
              ),
            )
            .limit(1)
        )[0];
        if (existing) return { conversation: existing, created: false };
        const pinned = await options.portraits.twinContext(
          candidateMemberId,
          undefined,
          transaction,
        );
        if (!pinned) return undefined;
        const conversation = (
          await transaction
            .insert(conversations)
            .values({
              id: randomUUID(),
              type: "TWIN",
              memberId: candidateMemberId,
              visitorMemberId: member.id,
              recommendationId: request.params.id,
              anonymousCode: randomUUID()
                .replaceAll("-", "")
                .slice(0, 12)
                .toUpperCase(),
              visibilityConsentAt: openedAt,
              profileVersionId: pinned.profileVersion.id,
              createdAt: openedAt,
            })
            .returning()
        )[0]!;
        return { conversation, created: true };
      });
      if (!result) {
        return reply.code(409).send({ code: "TWIN_NOT_PUBLISHED" });
      }
      const state = await candidateConversationState(
        options,
        result.conversation,
        "visitor",
      );
      if (!state) {
        return reply.code(409).send({ code: "TWIN_CONTEXT_NOT_AVAILABLE" });
      }
      return reply.code(result.created ? 201 : 200).send(state);
    },
  );

  app.post<{
    Params: { id: string };
    Body: { consentToOwnerVisibility: true };
  }>(
    "/api/member/contact-requests/:id/twin-conversation",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["consentToOwnerVisibility"],
          properties: {
            consentToOwnerVisibility: { type: "boolean", const: true },
          },
        },
      },
    },
    async (request, reply) => {
      const openedAt = now();
      const member = await memberForRequest(request, db, openedAt);
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      const requesterMemberId = await options.requesterForTwinConversation(
        member.id,
        request.params.id,
      );
      if (!requesterMemberId) {
        return reply.code(404).send({ code: "CONTACT_REQUEST_NOT_FOUND" });
      }
      const result = await db.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`${member.id}:${request.params.id}:contact-twin`}))`,
        );
        if (
          !(await options.requesterForTwinConversation(
            member.id,
            request.params.id,
            requesterMemberId,
            transaction,
          ))
        ) {
          return undefined;
        }
        const existing = (
          await transaction
            .select()
            .from(conversations)
            .where(
              and(
                eq(conversations.visitorMemberId, member.id),
                eq(conversations.contactRequestId, request.params.id),
                isNull(conversations.recommendationId),
              ),
            )
            .limit(1)
        )[0];
        if (existing) return { conversation: existing, created: false };
        const pinned = await options.portraits.twinContext(
          requesterMemberId,
          undefined,
          transaction,
        );
        if (!pinned) return undefined;
        const conversation = (
          await transaction
            .insert(conversations)
            .values({
              id: randomUUID(),
              type: "TWIN",
              memberId: requesterMemberId,
              visitorMemberId: member.id,
              contactRequestId: request.params.id,
              anonymousCode: randomUUID()
                .replaceAll("-", "")
                .slice(0, 12)
                .toUpperCase(),
              visibilityConsentAt: openedAt,
              profileVersionId: pinned.profileVersion.id,
              createdAt: openedAt,
            })
            .returning()
        )[0]!;
        return { conversation, created: true };
      });
      if (!result) {
        return reply.code(409).send({ code: "REQUESTER_TWIN_UNAVAILABLE" });
      }
      const state = await candidateConversationState(
        options,
        result.conversation,
        "visitor",
      );
      if (!state) {
        return reply.code(409).send({ code: "TWIN_CONTEXT_NOT_AVAILABLE" });
      }
      return reply.code(result.created ? 201 : 200).send(state);
    },
  );

  app.get(
    "/api/member/candidate-twin-conversations",
    async (request, reply) => {
      const member = await memberForRequest(request, db, now());
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      const owned = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.memberId, member.id),
            eq(conversations.type, "TWIN"),
            isNotNull(conversations.visitorMemberId),
          ),
        )
        .orderBy(desc(conversations.createdAt));
      // ponytail: owner history is small in the MVP; batch messages if this grows.
      const states = await Promise.all(
        owned.map((conversation) =>
          candidateConversationState(options, conversation, "owner"),
        ),
      );
      return { conversations: states.filter((state) => state !== undefined) };
    },
  );

  app.get<{ Params: { conversationId: string } }>(
    "/api/member/candidate-twin-conversations/:conversationId",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["conversationId"],
          properties: { conversationId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const member = await memberForRequest(request, db, now());
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      const conversation = (
        await db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.id, request.params.conversationId),
              eq(conversations.type, "TWIN"),
              isNotNull(conversations.visitorMemberId),
            ),
          )
          .limit(1)
      )[0];
      const viewer =
        conversation?.visitorMemberId === member.id
          ? "visitor"
          : conversation?.memberId === member.id
            ? "owner"
            : undefined;
      if (!conversation || !viewer) {
        return reply.code(404).send({ code: "CONVERSATION_NOT_FOUND" });
      }
      const state = await candidateConversationState(
        options,
        conversation,
        viewer,
      );
      if (!state) {
        return reply.code(404).send({ code: "CONVERSATION_NOT_FOUND" });
      }
      return state;
    },
  );

  app.post<{
    Params: { conversationId: string };
    Body: { clientMessageId: string; content: string };
  }>(
    "/api/member/candidate-twin-conversations/:conversationId/messages",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["conversationId"],
          properties: { conversationId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["clientMessageId", "content"],
          properties: {
            clientMessageId: { type: "string", format: "uuid" },
            content: { type: "string", minLength: 1, maxLength: 4_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const submittedAt = now();
      const member = await memberForRequest(request, db, submittedAt);
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      const content = request.body.content.trim();
      if (!content) return reply.code(400).send({ code: "EMPTY_MESSAGE" });
      const result = await reserveCandidateTwinMessage(options, {
        visitorMemberId: member.id,
        conversationId: request.params.conversationId,
        clientMessageId: request.body.clientMessageId,
        content,
        submittedAt,
      });
      if (!result) {
        return reply.code(429).send({ code: "CANDIDATE_TWIN_QUOTA_USED" });
      }
      if ("notFound" in result) {
        return reply.code(404).send({ code: "CONVERSATION_NOT_FOUND" });
      }
      if ("unavailable" in result) {
        return reply.code(409).send({ code: "CANDIDATE_TWIN_UNAVAILABLE" });
      }
      if ("inProgress" in result) {
        return reply.code(409).send({ code: "CANDIDATE_TWIN_IN_PROGRESS" });
      }
      return reply.code(202).send({
        conversationId: result.conversation.id,
        jobId: result.job.id,
        eventsUrl: `/api/member/candidate-twin-jobs/${result.job.id}/events`,
        quotaRemaining: result.quotaRemaining,
      });
    },
  );

  app.get<{ Params: { jobId: string } }>(
    "/api/member/candidate-twin-jobs/:jobId/events",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["jobId"],
          properties: { jobId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const member = await memberForRequest(request, db, now());
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      const job = await agentJobs.findForMember(request.params.jobId, member.id);
      if (!job || job.task !== "reply_as_twin" || !job.conversationId) {
        return reply.code(404).send({ code: "AGENT_JOB_NOT_FOUND" });
      }
      const conversation = (
        await db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.id, job.conversationId),
              eq(conversations.type, "TWIN"),
              eq(conversations.visitorMemberId, member.id),
            ),
          )
          .limit(1)
      )[0];
      if (!conversation) {
        return reply.code(404).send({ code: "AGENT_JOB_NOT_FOUND" });
      }
      const candidate = await candidatePublicProfileById(
        conversation.memberId,
        db,
      );
      if (!candidate) {
        return reply.code(404).send({ code: "AGENT_JOB_NOT_FOUND" });
      }
      const stream = new PassThrough();
      reply.headers({
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      void processConversationAgentJob(
        stream,
        job,
        {
          memberProfile: { ...candidate, birthDate: "", gender: "" },
          matchCriteria: null,
        },
        options,
      );
      return reply.send(stream);
    },
  );

  app.get("/api/member/interview", async (request, reply) => {
    const member = await memberForRequest(request, db, now());
    if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
    const portraitState = await options.portraits.interviewState(member.id);
    const conversation = (
      await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.memberId, member.id),
            eq(conversations.type, "INTERVIEW"),
            isNull(conversations.visitorMemberId),
          ),
        )
        .limit(1)
    )[0];
    if (!conversation) {
      return { conversationId: null, messages: [], ...portraitState };
    }
    const messages = await db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversation.id))
      .orderBy(asc(conversationMessages.sequence));
    const activeJob = portraitState.fixedInterview.completed
      ? await agentJobs.findActiveForConversationId(conversation.id)
      : undefined;
    return {
      conversationId: conversation.id,
      messages: messages.map(publicMessage),
      ...portraitState,
      autoFollowup: activeJob
        ? {
            jobId: activeJob.id,
            eventsUrl: `/api/member/interview/jobs/${activeJob.id}/events`,
          }
        : undefined,
    };
  });

  app.post<{
    Body: { clientMessageId: string; content: string };
  }>(
    "/api/member/interview/messages",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["clientMessageId", "content"],
          properties: {
            clientMessageId: { type: "string", format: "uuid" },
            content: { type: "string", minLength: 1, maxLength: 4_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const submittedAt = now();
      const member = await memberForRequest(request, db, submittedAt);
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      if (!(await options.portraits.fixedInterviewComplete(member.id))) {
        return reply.code(409).send({ code: "FIXED_INTERVIEW_REQUIRED" });
      }
      const content = request.body.content.trim();
      if (!content) return reply.code(400).send({ code: "EMPTY_MESSAGE" });
      const result = await reserveOwnAgentMessage(options, {
        memberId: member.id,
        type: "INTERVIEW",
        clientMessageId: request.body.clientMessageId,
        content,
        submittedAt,
      });

      if (!result) return reply.code(429).send({ code: "OWN_AGENT_QUOTA_USED" });
      if ("inProgress" in result) {
        return reply.code(409).send({ code: "INTERVIEW_IN_PROGRESS" });
      }
      return reply.code(202).send({
        conversationId: result.conversation.id,
        jobId: result.job.id,
        eventsUrl: `/api/member/interview/jobs/${result.job.id}/events`,
        quotaRemaining: result.quotaRemaining,
      });
    },
  );

  app.get<{ Params: { jobId: string } }>(
    "/api/member/interview/jobs/:jobId/events",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["jobId"],
          properties: { jobId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const member = await memberForRequest(request, db, now());
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      const job = await options.agentJobs.findForMember(
        request.params.jobId,
        member.id,
      );
      if (!job || job.task !== "continue_interview") {
        return reply.code(404).send({ code: "AGENT_JOB_NOT_FOUND" });
      }

      const stream = new PassThrough();
      reply.headers({
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const memberContext = await interviewContextForMember(member, db);
      void processConversationAgentJob(stream, job, memberContext, options);
      return reply.send(stream);
    },
  );

  app.get("/api/member/twin", async (request, reply) => {
    const member = await memberForRequest(request, db, now());
    if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
    const published = await options.portraits.twinContext(member.id);
    if (!published) {
      return reply.code(409).send({ code: "TWIN_NOT_PUBLISHED" });
    }
    const conversation = (
      await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.memberId, member.id),
            eq(conversations.type, "TWIN"),
            isNull(conversations.visitorMemberId),
          ),
        )
        .limit(1)
    )[0];
    if (!conversation) {
      return {
        conversationId: null,
        profileVersion: published.profileVersion,
        messages: [],
      };
    }
    const pinned = conversation.profileVersionId
      ? await options.portraits.twinContext(
          member.id,
          conversation.profileVersionId,
        )
      : undefined;
    if (!pinned) {
      return reply.code(409).send({ code: "TWIN_CONTEXT_NOT_AVAILABLE" });
    }
    const [messages, activeJob] = await Promise.all([
      db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, conversation.id))
        .orderBy(asc(conversationMessages.sequence)),
      agentJobs.findActiveForConversationId(conversation.id),
    ]);
    return {
      conversationId: conversation.id,
      profileVersion: pinned.profileVersion,
      messages: messages.map(publicMessage),
      autoFollowup: activeJob
        ? {
            jobId: activeJob.id,
            eventsUrl: `/api/member/twin/jobs/${activeJob.id}/events`,
          }
        : undefined,
    };
  });

  app.post<{
    Body: { clientMessageId: string; content: string };
  }>(
    "/api/member/twin/messages",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["clientMessageId", "content"],
          properties: {
            clientMessageId: { type: "string", format: "uuid" },
            content: { type: "string", minLength: 1, maxLength: 4_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const submittedAt = now();
      const member = await memberForRequest(request, db, submittedAt);
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      const content = request.body.content.trim();
      if (!content) return reply.code(400).send({ code: "EMPTY_MESSAGE" });
      let result: Awaited<ReturnType<typeof reserveOwnAgentMessage>>;
      try {
        result = await reserveOwnAgentMessage(options, {
          memberId: member.id,
          type: "TWIN",
          clientMessageId: request.body.clientMessageId,
          content,
          submittedAt,
        });
      } catch (error) {
        if (error instanceof AgentRunError && error.code === "TWIN_NOT_PUBLISHED") {
          return reply.code(409).send({ code: "TWIN_NOT_PUBLISHED" });
        }
        throw error;
      }
      if (!result) return reply.code(429).send({ code: "OWN_AGENT_QUOTA_USED" });
      if ("inProgress" in result) {
        return reply.code(409).send({ code: "TWIN_IN_PROGRESS" });
      }
      return reply.code(202).send({
        conversationId: result.conversation.id,
        jobId: result.job.id,
        eventsUrl: `/api/member/twin/jobs/${result.job.id}/events`,
        quotaRemaining: result.quotaRemaining,
      });
    },
  );

  app.get<{ Params: { jobId: string } }>(
    "/api/member/twin/jobs/:jobId/events",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["jobId"],
          properties: { jobId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const member = await memberForRequest(request, db, now());
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      const job = await options.agentJobs.findForMember(
        request.params.jobId,
        member.id,
      );
      if (!job || job.task !== "reply_as_twin" || !job.conversationId) {
        return reply.code(404).send({ code: "AGENT_JOB_NOT_FOUND" });
      }
      const conversation = (
        await db
          .select({
            type: conversations.type,
            visitorMemberId: conversations.visitorMemberId,
          })
          .from(conversations)
          .where(eq(conversations.id, job.conversationId))
          .limit(1)
      )[0];
      if (
        conversation?.type !== "TWIN" ||
        conversation.visitorMemberId !== null
      ) {
        return reply.code(404).send({ code: "AGENT_JOB_NOT_FOUND" });
      }

      const stream = new PassThrough();
      reply.headers({
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      void processConversationAgentJob(
        stream,
        job,
        {
          memberProfile: publicProfile(member),
          matchCriteria: null,
        },
        options,
      );
      return reply.send(stream);
    },
  );

  app.get("/api/admin/agent-runs", async (request, reply) => {
    const actor = await adminForRequest(request, db, now());
    if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
    const runs = await options.agentJobs.listRuns(actor);
    return { runs };
  });

  app.get("/api/admin/agent-jobs/failed", async (request, reply) => {
    const actor = await adminForRequest(request, db, now());
    if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
    const jobs = await options.agentJobs.listFailed(actor);
    return {
      jobs: jobs.map((job) => ({
        id: job.id,
        role: job.role,
        task: job.task,
        memberId: job.memberId,
        profileVersionId: job.profileVersionId,
        calibrationScenarioId: job.calibrationScenarioId,
        assignedAdminId: job.assignedAdminId,
        retryCount: job.retryCount,
        error: job.error,
        failedAt: job.completedAt?.toISOString() ?? null,
      })),
    };
  });

  app.post<{ Params: { jobId: string } }>(
    "/api/admin/agent-jobs/:jobId/retry",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["jobId"],
          properties: { jobId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const actor = await adminForRequest(request, db, now());
      if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
      const job = await options.agentJobs.retryFailed(request.params.jobId, actor);
      if (!job) return reply.code(409).send({ code: "AGENT_JOB_NOT_RETRYABLE" });
      return reply.code(202).send({ jobId: job.id, status: job.status });
    },
  );

  app.post<{ Params: { jobId: string }; Body: { adminId: string } }>(
    "/api/admin/agent-jobs/:jobId/assignment",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["jobId"],
          properties: { jobId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["adminId"],
          properties: { adminId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const actor = await superAdminForRequest(request, db, now());
      if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
      if (!(await activeAdminById(request.body.adminId, db))) {
        return reply.code(400).send({ code: "ADMIN_ASSIGNEE_REQUIRED" });
      }
      const job = await options.agentJobs.assignFailed(
        request.params.jobId,
        request.body.adminId,
      );
      if (!job) return reply.code(409).send({ code: "AGENT_JOB_NOT_ASSIGNABLE" });
      return { jobId: job.id, assignedAdminId: job.assignedAdminId };
    },
  );
}
