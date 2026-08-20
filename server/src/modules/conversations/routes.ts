import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, lt, max, sql } from "drizzle-orm";
import type { Database } from "../../db.js";
import { AgentEngine, AgentRunError } from "../agent-engine/engine.js";
import { type AgentJob, AgentJobs } from "../agent-engine/jobs.js";
import {
  interviewContextForMember,
  memberForRequest,
  superAdminForRequest,
} from "../members/routes.js";
import {
  conversationMessages,
  conversations,
  ownAgentDailyQuotas,
} from "./schema.js";
import type { Portraits } from "../portraits/service.js";

const OWN_AGENT_DAILY_LIMIT = 100;
const JOB_LEASE_MS = 2 * 60 * 1_000;
const JOB_HEARTBEAT_MS = 30 * 1_000;

export interface ConversationsOptions {
  db: Database;
  agentEngine: AgentEngine;
  agentJobs: AgentJobs;
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

async function processInterviewJob(
  stream: PassThrough,
  job: AgentJob,
  memberContext: Awaited<ReturnType<typeof interviewContextForMember>>,
  options: ConversationsOptions,
) {
  const { agentEngine, agentJobs, db, now, portraits } = options;
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

  try {
    const input = (
      await db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.id, claimed.inputMessageId))
        .limit(1)
    )[0]!;
    const recentHistory = await db
      .select({
        role: conversationMessages.role,
        content: conversationMessages.content,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, claimed.conversationId),
          lt(conversationMessages.sequence, input.sequence),
        ),
      )
      .orderBy(desc(conversationMessages.sequence))
      .limit(200);
    const history = recentHistory.reverse();
    const extraction = await portraits.extractDraft(
      claimed.memberId,
      claimed.conversationId,
      input.sequence,
      agentEngine,
      (attempts) =>
        agentJobs.recordAttempts(
          claimed,
          attempts,
          now(),
          agentEngine.extractorDefinition,
        ),
    );
    if (extraction.completed > extraction.previousCompleted) {
      stream.write(
        sse("progress", {
          completed: extraction.completed,
          total: 8,
          feedback: "我对你的理解又清楚了一些",
        }),
      );
    }
    const portraitContext = await portraits.draftForInterviewer(
      claimed.memberId,
      input.content,
    );
    const result = await agentEngine.continueInterview(
      { ...memberContext, ...portraitContext, recentMessages: history },
      input.content,
      (text) => stream.write(sse("delta", { text })),
      (attempts) => agentJobs.recordAttempts(claimed, attempts, now()),
    );
    retryCount = result.retryCount;
    switchedModel = result.switchedModel;
    modelCompleted = true;
    const completedAt = now();
    const answer = await db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${claimed.conversationId}))`,
      );
      const lastSequence = (
        await transaction
          .select({ value: max(conversationMessages.sequence) })
          .from(conversationMessages)
          .where(eq(conversationMessages.conversationId, claimed.conversationId))
      )[0]?.value;
      const answerId = randomUUID();
      const saved = (
        await transaction
          .insert(conversationMessages)
          .values({
            id: answerId,
            conversationId: claimed.conversationId,
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
    await db.transaction(async (transaction) => {
      const failed = await agentJobs.fail(
        transaction,
        claimed,
        code,
        retryCount,
        switchedModel,
        failedAt,
      );
      if (failed) {
        await transaction
          .update(ownAgentDailyQuotas)
          .set({ used: sql`${ownAgentDailyQuotas.used} - 1`, updatedAt: failedAt })
          .where(
            and(
              eq(ownAgentDailyQuotas.memberId, claimed.memberId),
              eq(ownAgentDailyQuotas.quotaDate, beijingDate(claimed.createdAt)),
            ),
          );
      }
    });
    stream.end(sse("error", { code }));
  } finally {
    clearInterval(heartbeat);
  }
}

export function registerConversationsRoutes(
  app: FastifyInstance,
  options: ConversationsOptions,
) {
  const { agentJobs, db, now } = options;

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
    return {
      conversationId: conversation.id,
      messages: messages.map(publicMessage),
      ...portraitState,
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
      const quotaDate = beijingDate(submittedAt);

      const result = await db.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`${member.id}:${quotaDate}`}))`,
        );
        await transaction
          .insert(conversations)
          .values({
            id: randomUUID(),
            type: "INTERVIEW",
            memberId: member.id,
            createdAt: submittedAt,
          })
          .onConflictDoNothing();
        const conversation = (
          await transaction
            .select()
            .from(conversations)
            .where(
              and(
                eq(conversations.memberId, member.id),
                eq(conversations.type, "INTERVIEW"),
              ),
            )
            .limit(1)
        )[0]!;
        const duplicate = (
          await transaction
            .select()
            .from(conversationMessages)
            .where(
              and(
                eq(conversationMessages.conversationId, conversation.id),
                eq(
                  conversationMessages.clientMessageId,
                  request.body.clientMessageId,
                ),
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
                eq(ownAgentDailyQuotas.memberId, member.id),
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
            quotaRemaining: OWN_AGENT_DAILY_LIMIT - (quota?.used ?? 0),
          };
        }
        if (
          await agentJobs.findActiveForConversation(transaction, conversation.id)
        ) {
          return { inProgress: true as const };
        }
        if ((quota?.used ?? 0) >= OWN_AGENT_DAILY_LIMIT) return undefined;
        if (quota) {
          await transaction
            .update(ownAgentDailyQuotas)
            .set({ used: quota.used + 1, updatedAt: submittedAt })
            .where(
              and(
                eq(ownAgentDailyQuotas.memberId, member.id),
                eq(ownAgentDailyQuotas.quotaDate, quotaDate),
              ),
            );
        } else {
          await transaction.insert(ownAgentDailyQuotas).values({
            memberId: member.id,
            quotaDate,
            used: 1,
            updatedAt: submittedAt,
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
              content,
              sequence: (lastSequence ?? 0) + 1,
              clientMessageId: request.body.clientMessageId,
              createdAt: submittedAt,
            })
            .returning()
        )[0]!;
        const definition = options.agentEngine.interviewerDefinition;
        const job = await agentJobs.create(transaction, {
          id: randomUUID(),
          role: definition.role,
          task: definition.task,
          definitionVersion: definition.version,
          promptVersion: definition.promptVersion,
          schemaVersion: definition.schemaVersion,
          memberId: member.id,
          conversationId: conversation.id,
          inputMessageId: message.id,
          status: "pending",
          retryCount: 0,
          switchedModel: false,
          quotaRefunded: false,
          createdAt: submittedAt,
        });
        return {
          conversation,
          job,
          quotaRemaining: OWN_AGENT_DAILY_LIMIT - (quota?.used ?? 0) - 1,
        };
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
      if (!job) return reply.code(404).send({ code: "AGENT_JOB_NOT_FOUND" });

      const stream = new PassThrough();
      reply.headers({
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const memberContext = await interviewContextForMember(member, db);
      void processInterviewJob(stream, job, memberContext, options);
      return reply.send(stream);
    },
  );

  app.get("/api/admin/agent-runs", async (request, reply) => {
    const actor = await superAdminForRequest(request, db, now());
    if (!actor) return reply.code(403).send({ code: "FORBIDDEN" });
    const runs = await options.agentJobs.listRuns();
    return { runs };
  });
}
