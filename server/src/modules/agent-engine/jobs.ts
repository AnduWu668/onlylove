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

  async enqueueInterview(values: {
    transaction: DatabaseTransaction;
    memberId: string;
    conversationId: string;
    inputMessageId: string;
    definition: {
      role: "portrait_interviewer";
      task: "continue_interview";
      version: string;
      promptVersion: string;
      schemaVersion: null;
    };
    createdAt: Date;
  }) {
    const existing = await this.findByInput(
      values.transaction,
      values.inputMessageId,
    );
    if (existing) return existing;
    return this.create(values.transaction, {
      id: randomUUID(),
      role: values.definition.role,
      task: values.definition.task,
      definitionVersion: values.definition.version,
      promptVersion: values.definition.promptVersion,
      schemaVersion: values.definition.schemaVersion,
      memberId: values.memberId,
      conversationId: values.conversationId,
      inputMessageId: values.inputMessageId,
      status: "pending",
      retryCount: 0,
      switchedModel: false,
      quotaRefunded: false,
      createdAt: values.createdAt,
    });
  }

  enqueueTwinCalibration(values: {
    transaction: DatabaseTransaction;
    memberId: string;
    conversationId: string;
    inputMessageId: string;
    profileVersionId: string;
    calibrationScenarioId: string;
    definition: {
      role: "public_twin";
      task: "reply_as_twin";
      version: string;
      promptVersion: string;
      schemaVersion: null;
    };
    createdAt: Date;
  }) {
    return this.create(values.transaction, {
      id: randomUUID(),
      role: values.definition.role,
      task: values.definition.task,
      definitionVersion: values.definition.version,
      promptVersion: values.definition.promptVersion,
      schemaVersion: values.definition.schemaVersion,
      memberId: values.memberId,
      conversationId: values.conversationId,
      inputMessageId: values.inputMessageId,
      profileVersionId: values.profileVersionId,
      calibrationScenarioId: values.calibrationScenarioId,
      status: "pending",
      retryCount: 0,
      switchedModel: false,
      quotaRefunded: false,
      createdAt: values.createdAt,
    });
  }

  calibrationJobsForVersion(profileVersionId: string) {
    return this.db
      .select()
      .from(agentJobs)
      .where(
        and(
          eq(agentJobs.profileVersionId, profileVersionId),
          eq(agentJobs.task, "reply_as_twin"),
        ),
      );
  }

  async requeueFailed(id: string) {
    return (
      await this.db
        .update(agentJobs)
        .set({
          status: "pending",
          error: null,
          leaseToken: null,
          leaseExpiresAt: null,
          completedAt: null,
        })
        .where(and(eq(agentJobs.id, id), eq(agentJobs.status, "failed")))
        .returning()
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

  async findActiveForConversationId(conversationId: string) {
    return this.db.transaction((transaction) =>
      this.findActiveForConversation(transaction, conversationId),
    );
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

  async recordAttempts(
    job: AgentJob,
    attempts: AgentAttemptResult[],
    at: Date,
    definition?: {
      role: typeof job.role;
      task: typeof job.task;
      version: string;
      promptVersion: string;
      schemaVersion: string | null;
    },
  ) {
    if (!attempts.length) return;
    await this.db
      .insert(agentRuns)
      .values(
        attempts.map((attempt) => ({
          id: randomUUID(),
          jobId: job.id,
          role: definition?.role ?? job.role,
          task: definition?.task ?? job.task,
          definitionVersion: definition?.version ?? job.definitionVersion,
          promptVersion: definition?.promptVersion ?? job.promptVersion,
          schemaVersion: definition?.schemaVersion ?? job.schemaVersion,
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
    outputMessageId: string | null,
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
    refundQuota: boolean,
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
            quotaRefunded: refundQuota,
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

  async listRuns() {
    const rows = await this.db
      .select({
        run: agentRuns,
        profileVersionId: agentJobs.profileVersionId,
        calibrationScenarioId: agentJobs.calibrationScenarioId,
      })
      .from(agentRuns)
      .innerJoin(agentJobs, eq(agentJobs.id, agentRuns.jobId))
      .orderBy(desc(agentRuns.createdAt), asc(agentRuns.retryCount));
    return rows.map(({ run, ...jobReferences }) => ({
      ...run,
      ...jobReferences,
    }));
  }
}
