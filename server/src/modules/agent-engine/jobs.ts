import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
} from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import { conversationMessages } from "../conversations/schema.js";
import type { AgentAttemptResult } from "./engine.js";
import { agentJobs, agentRuns } from "./schema.js";

export type AgentJob = typeof agentJobs.$inferSelect;
const MAX_JOB_ATTEMPTS = 3;
type TaskAdmin = { id: string; role: "admin" | "super_admin" };

function beijingDate(value: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function terminalFailure() {
  return or(
    gte(agentJobs.retryCount, MAX_JOB_ATTEMPTS),
    isNotNull(agentJobs.conversationId),
  );
}

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
      profileVersionId: values.profileVersionId,
      calibrationScenarioId: values.calibrationScenarioId,
      status: "pending",
      retryCount: 0,
      switchedModel: false,
      quotaRefunded: false,
      createdAt: values.createdAt,
    });
  }

  enqueueMatching(values: {
    transaction: DatabaseTransaction;
    memberId: string;
    profileVersionId: string;
    definition: {
      role: "match_evaluator";
      task: "evaluate_pair";
      version: string;
      promptVersion: string;
      schemaVersion: string;
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
      profileVersionId: values.profileVersionId,
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
          isNotNull(agentJobs.calibrationScenarioId),
        ),
      );
  }

  async retryFailed(id: string, actor: TaskAdmin) {
    return (
      await this.db
        .update(agentJobs)
        .set({
          status: "pending",
          retryCount: 0,
          error: null,
          leaseToken: null,
          leaseExpiresAt: null,
          completedAt: null,
        })
        .where(
          and(
            eq(agentJobs.id, id),
            eq(agentJobs.status, "failed"),
            terminalFailure(),
            actor.role === "super_admin"
              ? undefined
              : eq(agentJobs.assignedAdminId, actor.id),
          ),
        )
        .returning()
    )[0];
  }

  async nextCalibrationJob(at: Date) {
    return this.nextTaskJob("reply_as_twin", at, true);
  }

  async nextMatchingJob(at: Date) {
    return this.nextTaskJob("evaluate_pair", at);
  }

  private async nextTaskJob(
    task: "reply_as_twin" | "evaluate_pair",
    at: Date,
    calibrationOnly = false,
  ) {
    return (
      await this.db
        .select()
        .from(agentJobs)
        .where(
          and(
            eq(agentJobs.task, task),
            calibrationOnly
              ? isNotNull(agentJobs.calibrationScenarioId)
              : undefined,
            or(
              eq(agentJobs.status, "pending"),
              and(
                eq(agentJobs.status, "failed"),
                lt(agentJobs.retryCount, MAX_JOB_ATTEMPTS),
              ),
              and(
                eq(agentJobs.status, "running"),
                or(
                  isNull(agentJobs.leaseExpiresAt),
                  lte(agentJobs.leaseExpiresAt, at),
                ),
              ),
            ),
          ),
        )
        .orderBy(asc(agentJobs.createdAt))
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

  async findActiveForConversationId(conversationId: string) {
    return this.db.transaction((transaction) =>
      this.findActiveForConversation(transaction, conversationId),
    );
  }

  async latestForConversation(
    conversationId: string,
    database: Database | DatabaseTransaction = this.db,
  ) {
    return (
      await database
        .select({ job: agentJobs })
        .from(agentJobs)
        .innerJoin(
          conversationMessages,
          eq(conversationMessages.id, agentJobs.inputMessageId),
        )
        .where(eq(agentJobs.conversationId, conversationId))
        .orderBy(desc(conversationMessages.sequence))
        .limit(1)
    )[0]?.job;
  }

  async claim(
    id: string,
    startedAt: Date,
    leaseExpiresAt: Date,
    options: { retryFailed?: boolean } = {},
  ) {
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
              options.retryFailed
                ? and(
                    eq(agentJobs.status, "failed"),
                    lt(agentJobs.retryCount, MAX_JOB_ATTEMPTS),
                  )
                : undefined,
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

  async purgeMemberData(
    memberId: string,
    conversationIds: string[],
    relatedJobIds: string[],
    database: DatabaseTransaction,
  ) {
    const jobs = await database
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(
        or(
          eq(agentJobs.memberId, memberId),
          conversationIds.length
            ? inArray(agentJobs.conversationId, conversationIds)
            : undefined,
          relatedJobIds.length ? inArray(agentJobs.id, relatedJobIds) : undefined,
        ),
      );
    const ids = jobs.map(({ id }) => id);
    if (!ids.length) return;
    await database.delete(agentRuns).where(inArray(agentRuns.jobId, ids));
    await database.delete(agentJobs).where(inArray(agentJobs.id, ids));
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
      );
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
            quotaRefunded: job.quotaRefunded || refundQuota,
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

  async listRuns(actor: TaskAdmin) {
    const rows = await this.db
      .select({
        run: agentRuns,
        profileVersionId: agentJobs.profileVersionId,
        calibrationScenarioId: agentJobs.calibrationScenarioId,
      })
      .from(agentRuns)
      .innerJoin(agentJobs, eq(agentJobs.id, agentRuns.jobId))
      .where(
        actor.role === "super_admin"
          ? undefined
          : eq(agentJobs.assignedAdminId, actor.id),
      )
      .orderBy(desc(agentRuns.createdAt), asc(agentRuns.retryCount));
    return rows.map(({ run, ...jobReferences }) => ({
      ...run,
      ...jobReferences,
    }));
  }

  async observability() {
    // ponytail: in-memory grouping keeps one source of truth; move to SQL GROUP BY when run volume affects latency.
    const runs = await this.db
      .select()
      .from(agentRuns)
      .orderBy(desc(agentRuns.createdAt));
    type Aggregate = {
      date: string;
      role: string;
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      estimatedCostMicroCny: number;
      latencyMs: number;
      runs: number;
      failures: number;
      modelSwitches: number;
    };
    const grouped = new Map<string, Aggregate>();
    for (const run of runs) {
      const date = beijingDate(run.createdAt);
      const key = [date, run.role, run.provider, run.actualModel].join("\u0000");
      const aggregate = grouped.get(key) ?? {
        date,
        role: run.role,
        provider: run.provider,
        model: run.actualModel,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostMicroCny: 0,
        latencyMs: 0,
        runs: 0,
        failures: 0,
        modelSwitches: 0,
      };
      aggregate.inputTokens += run.inputTokens;
      aggregate.outputTokens += run.outputTokens;
      aggregate.estimatedCostMicroCny += run.estimatedCostMicroCny;
      aggregate.latencyMs += run.latencyMs;
      aggregate.runs += 1;
      aggregate.failures += Number(Boolean(run.error));
      aggregate.modelSwitches += Number(run.switchedModel);
      grouped.set(key, aggregate);
    }
    const totalLatency = runs.reduce((total, run) => total + run.latencyMs, 0);
    const microCost = runs.reduce(
      (total, run) => total + run.estimatedCostMicroCny,
      0,
    );
    const pricing = [
      ...new Map(
        runs
          .filter((run) => run.pricingEffectiveDate)
          .map((run) => [
            [run.provider, run.actualModel, run.pricingEffectiveDate].join("\u0000"),
            {
              provider: run.provider,
              model: run.actualModel,
              effectiveDate: run.pricingEffectiveDate,
              inputCostCnyPerMillionTokens:
                run.inputCostCnyPerMillionTokens,
              outputCostCnyPerMillionTokens:
                run.outputCostCnyPerMillionTokens,
            },
          ]),
      ).values(),
    ];
    return {
      summary: {
        inputTokens: runs.reduce((total, run) => total + run.inputTokens, 0),
        outputTokens: runs.reduce((total, run) => total + run.outputTokens, 0),
        estimatedCostCny: microCost / 1_000_000,
        averageLatencyMs: runs.length ? Math.round(totalLatency / runs.length) : 0,
        failures: runs.filter((run) => run.error).length,
        modelSwitches: runs.filter((run) => run.switchedModel).length,
      },
      groups: [...grouped.values()]
        .sort((left, right) => right.date.localeCompare(left.date))
        .map((group) => ({
          ...group,
          estimatedCostCny: group.estimatedCostMicroCny / 1_000_000,
          averageLatencyMs: Math.round(group.latencyMs / group.runs),
        })),
      pricing,
      disclaimer:
        "人民币成本为按生效单价计算的估算值，供应商最终账单是最终费用依据。",
    };
  }

  async listFailed(actor: TaskAdmin) {
    return this.db
      .select()
      .from(agentJobs)
      .where(
        and(
          eq(agentJobs.status, "failed"),
          terminalFailure(),
          actor.role === "super_admin"
            ? undefined
            : eq(agentJobs.assignedAdminId, actor.id),
        ),
      )
      .orderBy(desc(agentJobs.completedAt));
  }

  async assignFailed(id: string, adminId: string) {
    return (
      await this.db
        .update(agentJobs)
        .set({ assignedAdminId: adminId })
        .where(
          and(
            eq(agentJobs.id, id),
            eq(agentJobs.status, "failed"),
            terminalFailure(),
          ),
        )
        .returning()
    )[0];
  }
}
