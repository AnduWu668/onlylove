import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
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

  async claim(id: string, startedAt: Date) {
    return (
      await this.db
        .update(agentJobs)
        .set({ status: "running", startedAt })
        .where(and(eq(agentJobs.id, id), eq(agentJobs.status, "pending")))
        .returning()
    )[0];
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
    retryCount: number,
    switchedModel: boolean,
    completedAt: Date,
  ) {
    await transaction
      .update(agentJobs)
      .set({ status: "completed", retryCount, switchedModel, completedAt })
      .where(eq(agentJobs.id, job.id));
  }

  async fail(
    transaction: DatabaseTransaction,
    job: AgentJob,
    code: string,
    retryCount: number,
    switchedModel: boolean,
    failedAt: Date,
  ) {
    await transaction
      .update(agentJobs)
      .set({
        status: "failed",
        error: code,
        retryCount,
        switchedModel,
        quotaRefunded: true,
        completedAt: failedAt,
      })
      .where(eq(agentJobs.id, job.id));
  }

  listRuns() {
    return this.db
      .select()
      .from(agentRuns)
      .orderBy(desc(agentRuns.createdAt), asc(agentRuns.retryCount));
  }
}
