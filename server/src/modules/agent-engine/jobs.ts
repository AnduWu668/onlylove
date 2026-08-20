import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import type { AgentAttemptResult } from "./engine.js";
import { agentJobs, agentRuns } from "./schema.js";

export type AgentJob = typeof agentJobs.$inferSelect;

export class AgentJobs {
  constructor(private readonly db: Database) {}

  async create(
    transaction: DatabaseTransaction,
    values: typeof agentJobs.$inferInsert,
  ) {
    return (
      await transaction.insert(agentJobs).values(values).returning()
    )[0]!;
  }

  async findByInput(transaction: DatabaseTransaction, inputMessageId: string) {
    return (
      await transaction
        .select()
        .from(agentJobs)
        .where(eq(agentJobs.inputMessageId, inputMessageId))
        .limit(1)
    )[0];
  }

  async findForMember(id: string, memberId: string) {
    return (
      await this.db
        .select()
        .from(agentJobs)
        .where(and(eq(agentJobs.id, id), eq(agentJobs.memberId, memberId)))
        .limit(1)
    )[0];
  }

  async findActiveForConversation(
    transaction: DatabaseTransaction,
    conversationId: string,
  ) {
    return (
      await transaction
        .select()
        .from(agentJobs)
        .where(
          and(
            eq(agentJobs.conversationId, conversationId),
            inArray(agentJobs.status, ["pending", "running"]),
          ),
        )
        .limit(1)
    )[0];
  }

  async claim(id: string, startedAt: Date, leaseExpiresAt: Date) {
    const leaseToken = randomUUID();
    return (
      await this.db
        .update(agentJobs)
        .set({ status: "running", startedAt, leaseToken, leaseExpiresAt })
        .where(
          and(
            eq(agentJobs.id, id),
            or(
              eq(agentJobs.status, "pending"),
              and(
                eq(agentJobs.status, "running"),
                or(
                  isNull(agentJobs.leaseExpiresAt),
                  lte(agentJobs.leaseExpiresAt, startedAt),
                ),
              ),
            ),
          ),
        )
        .returning()
    )[0];
  }

  async heartbeat(job: AgentJob, leaseExpiresAt: Date) {
    return Boolean(
      (
        await this.db
          .update(agentJobs)
          .set({ leaseExpiresAt })
          .where(
            and(
              eq(agentJobs.id, job.id),
              eq(agentJobs.status, "running"),
              eq(agentJobs.leaseToken, job.leaseToken!),
            ),
          )
          .returning({ id: agentJobs.id })
      )[0],
    );
  }

  async get(id: string) {
    return (
      await this.db.select().from(agentJobs).where(eq(agentJobs.id, id)).limit(1)
    )[0];
  }

  async recordAttempts(job: AgentJob, attempts: AgentAttemptResult[], at: Date) {
    if (!attempts.length) return;
    await this.db
      .insert(agentRuns)
      .values(
        attempts.map((attempt) => ({
          id: randomUUID(),
          jobId: job.id,
          role: job.role,
          task: job.task,
          definitionVersion: job.definitionVersion,
          promptVersion: job.promptVersion,
          schemaVersion: job.schemaVersion,
          memberId: job.memberId,
          conversationId: job.conversationId,
          ...attempt,
          createdAt: at,
        })),
      )
      .onConflictDoNothing();
  }

  async complete(
    transaction: DatabaseTransaction,
    job: AgentJob,
    outputMessageId: string,
    retryCount: number,
    switchedModel: boolean,
    completedAt: Date,
  ) {
    return Boolean(
      (
        await transaction
          .update(agentJobs)
          .set({
            status: "completed",
            outputMessageId,
            retryCount,
            switchedModel,
            leaseToken: null,
            leaseExpiresAt: null,
            completedAt,
          })
          .where(
            and(
              eq(agentJobs.id, job.id),
              eq(agentJobs.status, "running"),
              eq(agentJobs.leaseToken, job.leaseToken!),
            ),
          )
          .returning({ id: agentJobs.id })
      )[0],
    );
  }

  async fail(
    transaction: DatabaseTransaction,
    job: AgentJob,
    code: string,
    retryCount: number,
    switchedModel: boolean,
    failedAt: Date,
  ) {
    return Boolean(
      (
        await transaction
          .update(agentJobs)
          .set({
            status: "failed",
            error: code,
            retryCount,
            switchedModel,
            quotaRefunded: true,
            leaseToken: null,
            leaseExpiresAt: null,
            completedAt: failedAt,
          })
          .where(
            and(
              eq(agentJobs.id, job.id),
              eq(agentJobs.status, "running"),
              eq(agentJobs.leaseToken, job.leaseToken!),
            ),
          )
          .returning({ id: agentJobs.id })
      )[0],
    );
  }

  listRuns() {
    return this.db
      .select()
      .from(agentRuns)
      .orderBy(desc(agentRuns.createdAt), asc(agentRuns.retryCount));
  }
}
