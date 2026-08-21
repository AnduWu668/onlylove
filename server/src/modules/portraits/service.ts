import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../../db.js";
import {
  AgentEngine,
  AgentRunError,
  type AgentAttemptResult,
} from "../agent-engine/engine.js";
import type { AgentJobs } from "../agent-engine/jobs.js";
import type { InterviewConversations } from "../conversations/interview.js";
import {
  FIXED_INTERVIEW_QUESTIONS,
  PORTRAIT_DIMENSIONS,
  QUESTION_PLANNING_RULE,
  publicQuestion,
  type PortraitDimension,
} from "./questions.js";
import {
  portraitCalibrationAnswers,
  portraitCalibrationScenarios,
  portraitDrafts,
  portraitFixedAnswers,
  portraitMemberStates,
  portraitVersions,
  type PortraitDimensionDraft,
  type PortraitDraftContent,
  type CalibrationRating,
} from "./schema.js";

export const PORTRAIT_SCHEMA_VERSION = "portrait-draft-schema-v1";
export const QUESTION_PLANNER_VERSION = QUESTION_PLANNING_RULE.version;
const MATCH_PROFILE_SCHEMA_VERSION = "match-profile-v1";
const PERSONA_CONTEXT_SCHEMA_VERSION = "persona-context-v1";
const CALIBRATION_SCHEMA_VERSION = "portrait-calibration-v1";
const CALIBRATION_JOB_LEASE_MS = 2 * 60 * 1_000;

const DIMENSION_LABELS: Record<PortraitDimension, string> = {
  long_term_planning: "长期规划",
  values: "价值观",
  relationship_boundaries: "关系边界",
  communication: "沟通方式",
  conflict_repair: "冲突修复",
  emotional_support: "情感支持",
  lifestyle: "生活方式",
  family_and_finance: "家庭与财务",
};

const CALIBRATION_SCENARIO_SETS: readonly (readonly {
  dimensions: readonly PortraitDimension[];
  prompt: string;
}[])[] = [
  [
    {
      dimensions: ["long_term_planning"],
      prompt: "伴侣收到外地三年的理想工作机会，你会怎样一起决定？",
    },
    {
      dimensions: ["values"],
      prompt: "你发现伴侣做了一件合法但与你价值判断相冲的事，会怎么回应？",
    },
    {
      dimensions: ["relationship_boundaries"],
      prompt: "伴侣希望查看你的私人聊天来获得安全感，你会怎么处理？",
    },
    {
      dimensions: ["communication"],
      prompt: "你们对一件重要的事理解完全不同，你会怎样把话说清楚？",
    },
    {
      dimensions: ["conflict_repair"],
      prompt: "一次争执后双方都觉得受伤，你会怎样重新开始沟通？",
    },
    {
      dimensions: ["emotional_support"],
      prompt: "伴侣连续几周情绪低落又不想讲原因，你会做什么？",
    },
    {
      dimensions: ["lifestyle"],
      prompt: "你们一个想把周末排满，一个只想在家休息，会怎样安排？",
    },
    {
      dimensions: ["family_and_finance"],
      prompt: "一方家人临时需要一大笔钱，你希望两个人怎样作决定？",
    },
    {
      dimensions: ["long_term_planning", "lifestyle"],
      prompt: "你计划两年后回家乡，但伴侣的工作和日常都在本地，会怎样安排现在与未来？",
    },
    {
      dimensions: ["relationship_boundaries", "emotional_support"],
      prompt: "伴侣很需要陪伴，但你也急需独处恢复，你会怎样兼顾？",
    },
  ],
  [
    {
      dimensions: ["long_term_planning"],
      prompt: "你们对五年后生活的城市没有共识，会怎样推进决定？",
    },
    {
      dimensions: ["values"],
      prompt: "伴侣对你很在意的一项公共议题持相反立场，你会怎么相处？",
    },
    {
      dimensions: ["relationship_boundaries"],
      prompt: "伴侣常把你们的矛盾讲给朋友听，你会如何表达边界？",
    },
    {
      dimensions: ["communication"],
      prompt: "伴侣总说没事，但行为明显疏远，你会如何开启对话？",
    },
    {
      dimensions: ["conflict_repair"],
      prompt: "同一个争议第三次出现时，你会怎样避免重复争吵？",
    },
    {
      dimensions: ["emotional_support"],
      prompt: "伴侣经历失败后拒绝建议，你会怎样支持而不过度介入？",
    },
    {
      dimensions: ["lifestyle"],
      prompt: "你们作息长期错开，能相处的时间越来越少，会怎么调整？",
    },
    {
      dimensions: ["family_and_finance"],
      prompt: "你们对共同账户和个人账户的比例意见不同，会怎样决定？",
    },
    {
      dimensions: ["long_term_planning", "lifestyle"],
      prompt: "事业计划要求长期改变两个人的日常节奏，你会怎样作决定？",
    },
    {
      dimensions: ["relationship_boundaries", "emotional_support"],
      prompt: "伴侣焦虑时希望随时知道你的位置，但你感到被监控，会怎么处理？",
    },
  ],
];

const dimensionSchema = Type.Object({
  selfTendency: Type.Union([Type.String(), Type.Null()]),
  partnerExpectation: Type.Union([Type.String(), Type.Null()]),
  hardBoundary: Type.Union([Type.String(), Type.Null()]),
  importance: Type.Union([
    Type.Integer({ minimum: 1, maximum: 5 }),
    Type.Null(),
  ]),
  confidence: Type.Union([
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
  ]),
  evidenceMessageIds: Type.Array(Type.String()),
  contradictions: Type.Array(Type.String()),
});

export const portraitDraftSchema = Type.Object({
  long_term_planning: dimensionSchema,
  values: dimensionSchema,
  relationship_boundaries: dimensionSchema,
  communication: dimensionSchema,
  conflict_repair: dimensionSchema,
  emotional_support: dimensionSchema,
  lifestyle: dimensionSchema,
  family_and_finance: dimensionSchema,
});

function emptyDimension(): PortraitDimensionDraft {
  return {
    selfTendency: null,
    partnerExpectation: null,
    hardBoundary: null,
    importance: null,
    confidence: "low",
    evidenceMessageIds: [],
    contradictions: [],
  };
}

export function emptyPortraitDraft() {
  return Object.fromEntries(
    PORTRAIT_DIMENSIONS.map((dimension) => [dimension, emptyDimension()]),
  ) as PortraitDraftContent;
}

export class PortraitInputError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface FixedAnswerInput {
  questionId: string;
  selectedOptionIds: string[];
  noneApplies: boolean;
  freeText: string;
}

export interface CalibrationAnswerInput {
  rating: CalibrationRating;
  correction: string;
  criticalFabrication: boolean;
}

interface AutoFollowupOptions {
  agentJobs: AgentJobs;
  definition: AgentEngine["interviewerDefinition"];
}

interface VersionGenerationOptions {
  agentEngine: AgentEngine;
  agentJobs: AgentJobs;
}

function completedDimensions(content: PortraitDraftContent) {
  return PORTRAIT_DIMENSIONS.filter((dimension) =>
    ["medium", "high"].includes(content[dimension].confidence),
  ).length;
}

export function assessPortraitDraft(
  content: PortraitDraftContent,
  previousContent: PortraitDraftContent,
  validEvidenceIds: ReadonlySet<string>,
  newEvidenceIds: ReadonlySet<string>,
) {
  const valid = PORTRAIT_DIMENSIONS.every((dimension) => {
    const value = content[dimension];
    return (
      value.evidenceMessageIds.every((id) => validEvidenceIds.has(id)) &&
      (!["medium", "high"].includes(value.confidence) ||
        value.evidenceMessageIds.length > 0)
    );
  });
  const newlyConfident = PORTRAIT_DIMENSIONS.some(
    (dimension) =>
      previousContent[dimension].confidence === "low" &&
      ["medium", "high"].includes(content[dimension].confidence) &&
      content[dimension].evidenceMessageIds.some((id) =>
        newEvidenceIds.has(id),
      ),
  );
  return { valid, completed: completedDimensions(content), newlyConfident };
}

export function interviewPlanningPriority(
  content: PortraitDraftContent,
  latestMessage: string,
  commonWeaknessIndex: number,
) {
  if (/不像我|不是我|理解错|不准确|纠正/.test(latestMessage)) {
    return "member_correction";
  }
  const lowConfidence = PORTRAIT_DIMENSIONS.find(
    (dimension) => content[dimension].confidence === "low",
  );
  if (lowConfidence) return `low_confidence:${lowConfidence}`;
  const contradiction = PORTRAIT_DIMENSIONS.find(
    (dimension) => content[dimension].contradictions.length > 0,
  );
  if (contradiction) return `contradiction:${contradiction}`;
  const commonWeakness =
    QUESTION_PLANNING_RULE.commonWeaknesses[
      commonWeaknessIndex % QUESTION_PLANNING_RULE.commonWeaknesses.length
    ]!;
  return `published_common_weakness:${commonWeakness}`;
}

export function portraitExtractionPrompt(
  currentDraft: PortraitDraftContent,
  evidenceMessages: readonly {
    id: string;
    content: string;
    sequence: number;
  }[],
) {
  return JSON.stringify({
    instruction:
      "只依据 evidenceMessages 更新完整八维画像草稿。没有证据时保持原值或低置信度；矛盾写入 contradictions；每个结论只引用实际支持它的消息 id。",
    schemaVersion: PORTRAIT_SCHEMA_VERSION,
    currentDraft,
    evidenceMessages,
  });
}

function visibleState(memberId: string, answered: number, progress: number) {
  return {
    fixedInterview: {
      answered,
      total: FIXED_INTERVIEW_QUESTIONS.length,
      completed: answered === FIXED_INTERVIEW_QUESTIONS.length,
      question: publicQuestion(memberId, answered),
    },
    progress: { completed: progress, total: PORTRAIT_DIMENSIONS.length },
  };
}

function personaContext(content: PortraitDraftContent) {
  const dimensions = PORTRAIT_DIMENSIONS.map((dimension) => {
    const tendency = content[dimension].selfTendency;
    return `## ${DIMENSION_LABELS[dimension]}\n${tendency ?? "信息不足，回答时应坦承不确定。"}`;
  }).join("\n\n");
  return `# 恋爱分身上下文\n\n始终说明自己是 AI，不代表成员作出承诺；未知事实必须坦承不确定。\n\n${dimensions}`;
}

function calibrationScenarios(version: number) {
  return CALIBRATION_SCENARIO_SETS[(version - 1) % 2]!.map(
    (scenario, index) => ({
      id: randomUUID(),
      position: index + 1,
      dimensions: [...scenario.dimensions],
      prompt:
        version > 2
          ? `在共同生活进入第 ${version} 年时，${scenario.prompt}`
          : scenario.prompt,
      prediction: null,
    }),
  );
}

function calibrationOutcome(
  answers: readonly { rating: CalibrationRating; criticalFabrication: boolean }[],
  total = 10,
) {
  const likeCount = answers.filter((answer) => answer.rating === "like").length;
  const criticalFabrication = answers.some(
    (answer) => answer.criticalFabrication,
  );
  const complete = answers.length === total;
  return {
    answered: answers.length,
    likeCount,
    criticalFabrication,
    complete,
    passed: complete && likeCount >= 8 && !criticalFabrication,
  };
}

export class Portraits {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date,
    private readonly interviewConversations: InterviewConversations,
  ) {}

  async memberState(memberId: string) {
    const state = (
      await this.db
        .select()
        .from(portraitMemberStates)
        .where(eq(portraitMemberStates.memberId, memberId))
        .limit(1)
    )[0];
    if (!state) {
      return {
        status: "draft" as const,
        submittedVersion: null,
        publishedVersion: null,
      };
    }

    const [submitted, published, scenarios, answers] = await Promise.all([
      this.db
        .select()
        .from(portraitVersions)
        .where(eq(portraitVersions.id, state.submittedVersionId))
        .limit(1),
      state.publishedVersionId
        ? this.db
            .select()
            .from(portraitVersions)
            .where(eq(portraitVersions.id, state.publishedVersionId))
            .limit(1)
        : Promise.resolve([]),
      this.db
        .select()
        .from(portraitCalibrationScenarios)
        .where(
          eq(
            portraitCalibrationScenarios.portraitVersionId,
            state.submittedVersionId,
          ),
        )
        .orderBy(asc(portraitCalibrationScenarios.position)),
      this.db
        .select({
          scenarioId: portraitCalibrationAnswers.scenarioId,
          rating: portraitCalibrationAnswers.rating,
          correction: portraitCalibrationAnswers.correction,
          criticalFabrication:
            portraitCalibrationAnswers.criticalFabrication,
        })
        .from(portraitCalibrationAnswers)
        .innerJoin(
          portraitCalibrationScenarios,
          eq(
            portraitCalibrationScenarios.id,
            portraitCalibrationAnswers.scenarioId,
          ),
        )
        .where(
          eq(
            portraitCalibrationScenarios.portraitVersionId,
            state.submittedVersionId,
          ),
        ),
    ]);
    const answerByScenario = new Map(
      answers.map((answer) => [answer.scenarioId, answer]),
    );
    const outcome = calibrationOutcome(answers, scenarios.length);
    const isPublished = state.publishedVersionId === state.submittedVersionId;
    const publicVersion = (version: (typeof submitted)[number] | undefined) =>
      version
        ? {
            id: version.id,
            version: version.version,
            createdAt: version.createdAt.toISOString(),
          }
        : null;
    return {
      status: isPublished
        ? ("published" as const)
        : outcome.passed
          ? ("ready_to_publish" as const)
          : outcome.complete
            ? ("needs_more_understanding" as const)
            : ("calibrating" as const),
      ...(outcome.complete && !outcome.passed
        ? { message: "分身还需要继续了解你" }
        : {}),
      submittedVersion: publicVersion(submitted[0]),
      publishedVersion: publicVersion(published[0]),
      calibration: {
        answered: outcome.answered,
        total: scenarios.length,
        likeCount: outcome.likeCount,
        criticalFabrication: outcome.criticalFabrication,
        canPublish: outcome.passed,
        scenarios: scenarios.map((scenario) => ({
          id: scenario.id,
          number: scenario.position,
          kind: scenario.dimensions.length === 1 ? "single" : "conflict",
          prompt: scenario.prompt,
          prediction: scenario.prediction!,
          answer: answerByScenario.get(scenario.id) ?? null,
        })),
      },
    };
  }

  async submitCalibrationAnswer(
    memberId: string,
    scenarioId: string,
    input: CalibrationAnswerInput,
    autoFollowup: AutoFollowupOptions,
  ) {
    const correction = input.correction.trim();
    if (input.rating !== "like" && !correction) {
      throw new PortraitInputError("CALIBRATION_CORRECTION_REQUIRED");
    }
    if (input.rating === "like" && input.criticalFabrication) {
      throw new PortraitInputError("INVALID_CALIBRATION_ANSWER");
    }

    let followupJob:
      | Awaited<ReturnType<AgentJobs["enqueueInterview"]>>
      | undefined;
    await this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${memberId}))`,
      );
      const state = (
        await transaction
          .select()
          .from(portraitMemberStates)
          .where(eq(portraitMemberStates.memberId, memberId))
          .limit(1)
      )[0];
      if (!state) throw new PortraitInputError("PORTRAIT_VERSION_REQUIRED");
      const scenario = (
        await transaction
          .select()
          .from(portraitCalibrationScenarios)
          .where(
            and(
              eq(portraitCalibrationScenarios.id, scenarioId),
              eq(
                portraitCalibrationScenarios.portraitVersionId,
                state.submittedVersionId,
              ),
            ),
          )
          .limit(1)
      )[0];
      if (!scenario) {
        throw new PortraitInputError("CALIBRATION_SCENARIO_NOT_FOUND");
      }
      const existing = (
        await transaction
          .select({ scenarioId: portraitCalibrationAnswers.scenarioId })
          .from(portraitCalibrationAnswers)
          .where(eq(portraitCalibrationAnswers.scenarioId, scenarioId))
          .limit(1)
      )[0];
      if (existing) return;

      await transaction.insert(portraitCalibrationAnswers).values({
        scenarioId,
        rating: input.rating,
        correction,
        criticalFabrication: input.criticalFabrication,
        createdAt: this.now(),
      });
      const answers = await transaction
        .select({
          rating: portraitCalibrationAnswers.rating,
          correction: portraitCalibrationAnswers.correction,
          criticalFabrication:
            portraitCalibrationAnswers.criticalFabrication,
          position: portraitCalibrationScenarios.position,
          prompt: portraitCalibrationScenarios.prompt,
        })
        .from(portraitCalibrationAnswers)
        .innerJoin(
          portraitCalibrationScenarios,
          eq(
            portraitCalibrationScenarios.id,
            portraitCalibrationAnswers.scenarioId,
          ),
        )
        .where(
          eq(
            portraitCalibrationScenarios.portraitVersionId,
            state.submittedVersionId,
          ),
        );
      const outcome = calibrationOutcome(answers);
      if (!outcome.complete || outcome.passed) return;
      const content = answers
        .filter((answer) => answer.rating !== "like")
        .map(
          (answer) =>
            [
              `未见场景 ${answer.position}：${answer.prompt}`,
              `成员判断：${answer.rating === "partial" ? "部分像我" : "不像我"}`,
              `聚焦纠正：${answer.correction}`,
              answer.criticalFabrication ? "成员指出：包含关键事实捏造" : "",
            ]
              .filter(Boolean)
              .join("\n"),
        )
        .join("\n\n");
      const message = await this.interviewConversations.appendCalibrationCorrections(
        transaction,
        memberId,
        `分身校准后的理解纠正：\n\n${content}`,
        this.now(),
      );
      followupJob = await autoFollowup.agentJobs.enqueueInterview({
        transaction,
        memberId,
        conversationId: message.conversationId,
        inputMessageId: message.id,
        definition: autoFollowup.definition,
        createdAt: this.now(),
      });
    });
    return { state: await this.memberState(memberId), followupJob };
  }

  async publishVersion(memberId: string, versionId: string) {
    await this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${memberId}))`,
      );
      const state = (
        await transaction
          .select()
          .from(portraitMemberStates)
          .where(eq(portraitMemberStates.memberId, memberId))
          .limit(1)
      )[0];
      if (!state || state.submittedVersionId !== versionId) {
        throw new PortraitInputError("PORTRAIT_VERSION_NOT_CURRENT");
      }
      const answers = await transaction
        .select({
          rating: portraitCalibrationAnswers.rating,
          criticalFabrication:
            portraitCalibrationAnswers.criticalFabrication,
        })
        .from(portraitCalibrationAnswers)
        .innerJoin(
          portraitCalibrationScenarios,
          eq(
            portraitCalibrationScenarios.id,
            portraitCalibrationAnswers.scenarioId,
          ),
        )
        .where(
          eq(portraitCalibrationScenarios.portraitVersionId, versionId),
        );
      if (!calibrationOutcome(answers).passed) {
        throw new PortraitInputError("CALIBRATION_NOT_PASSED");
      }
      await transaction
        .update(portraitMemberStates)
        .set({ publishedVersionId: versionId, updatedAt: this.now() })
        .where(eq(portraitMemberStates.memberId, memberId));
    });
    return this.memberState(memberId);
  }

  async withdrawPublishedVersion(memberId: string) {
    await this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${memberId}))`,
      );
      await transaction
        .update(portraitMemberStates)
        .set({ publishedVersionId: null, updatedAt: this.now() })
        .where(eq(portraitMemberStates.memberId, memberId));
    });
    return this.memberState(memberId);
  }

  private async generateCalibrationPredictions(
    versionId: string,
    context: string,
    { agentEngine, agentJobs }: VersionGenerationOptions,
  ) {
    // ponytail: durable jobs run inline until the single worker claims business jobs.
    const [scenarios, savedJobs] = await Promise.all([
      this.db
        .select()
        .from(portraitCalibrationScenarios)
        .where(eq(portraitCalibrationScenarios.portraitVersionId, versionId))
        .orderBy(asc(portraitCalibrationScenarios.position)),
      agentJobs.calibrationJobsForVersion(versionId),
    ]);
    const jobByScenario = new Map(
      savedJobs.map((job) => [job.calibrationScenarioId, job]),
    );
    for (const scenario of scenarios) {
      if (scenario.prediction) continue;
      let job = jobByScenario.get(scenario.id);
      if (!job) throw new Error("CALIBRATION_JOB_MISSING");
      if (job.status === "failed") job = (await agentJobs.requeueFailed(job.id))!;
      const startedAt = this.now();
      const claimed = await agentJobs.claim(
        job.id,
        startedAt,
        new Date(startedAt.getTime() + CALIBRATION_JOB_LEASE_MS),
      );
      if (!claimed) {
        const current = await agentJobs.get(job.id);
        if (current?.status === "completed") continue;
        throw new PortraitInputError("PORTRAIT_SUBMISSION_IN_PROGRESS");
      }
      try {
        const result = await agentEngine.replyAsTwin(
          context,
          scenario.prompt,
          (attempts) =>
            agentJobs.recordAttempts(
              claimed,
              attempts,
              this.now(),
              agentEngine.twinDefinition,
            ),
        );
        await this.db.transaction(async (transaction) => {
          await transaction
            .update(portraitCalibrationScenarios)
            .set({ prediction: result.text })
            .where(eq(portraitCalibrationScenarios.id, scenario.id));
          const completed = await agentJobs.complete(
            transaction,
            claimed,
            null,
            result.retryCount,
            result.switchedModel,
            this.now(),
          );
          if (!completed) throw new Error("AGENT_JOB_LEASE_LOST");
        });
      } catch (error) {
        const runError = error instanceof AgentRunError ? error : undefined;
        await this.db.transaction((transaction) =>
          agentJobs.fail(
            transaction,
            claimed,
            runError?.code ?? "MODEL_REQUEST_FAILED",
            runError?.retryCount ?? 0,
            runError?.switchedModel ?? false,
            false,
            this.now(),
          ),
        );
        throw error;
      }
    }
  }

  async submitVersion(
    memberId: string,
    clientRequestId: string,
    generation: VersionGenerationOptions,
  ) {
    const interviewConversationId =
      await this.interviewConversations.conversationIdForMember(
        memberId,
        "INTERVIEW",
      );
    if (
      interviewConversationId &&
      (await generation.agentJobs.findActiveForConversationId(
        interviewConversationId,
      ))
    ) {
      throw new PortraitInputError("PORTRAIT_DRAFT_UPDATING");
    }
    const result = await this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${memberId}))`,
      );
      const existing = (
        await transaction
          .select()
          .from(portraitVersions)
          .where(
            and(
              eq(portraitVersions.memberId, memberId),
              eq(portraitVersions.clientRequestId, clientRequestId),
            ),
          )
          .limit(1)
      )[0];
      if (existing) {
        return {
          created: false,
          versionId: existing.id,
          version: existing.version,
          personaContext: existing.personaContext,
        };
      }

      const draft = (
        await transaction
          .select()
          .from(portraitDrafts)
          .where(eq(portraitDrafts.memberId, memberId))
          .limit(1)
      )[0];
      if (!draft) throw new PortraitInputError("PORTRAIT_DRAFT_REQUIRED");
      const current = (
        await transaction
          .select({ version: portraitVersions.version })
          .from(portraitVersions)
          .where(eq(portraitVersions.memberId, memberId))
          .orderBy(desc(portraitVersions.version))
          .limit(1)
      )[0];
      const version = (current?.version ?? 0) + 1;
      const id = randomUUID();
      const createdAt = this.now();
      const context = personaContext(draft.content);
      await transaction.insert(portraitVersions).values({
        id,
        memberId,
        version,
        clientRequestId,
        sourceDraftSchemaVersion: draft.schemaVersion,
        matchProfile: {
          schemaVersion: MATCH_PROFILE_SCHEMA_VERSION,
          dimensions: draft.content,
        },
        personaContextSchemaVersion: PERSONA_CONTEXT_SCHEMA_VERSION,
        personaContext: context,
        calibrationSchemaVersion: CALIBRATION_SCHEMA_VERSION,
        createdAt,
      });
      const scenarios = calibrationScenarios(version);
      await transaction.insert(portraitCalibrationScenarios).values(
        scenarios.map((scenario) => ({
          ...scenario,
          portraitVersionId: id,
          createdAt,
        })),
      );
      for (const scenario of scenarios) {
        const message = await this.interviewConversations.appendCalibrationScenario(
          transaction,
          memberId,
          scenario.prompt,
          createdAt,
        );
        await generation.agentJobs.enqueueTwinCalibration({
          transaction,
          memberId,
          conversationId: message.conversationId,
          inputMessageId: message.id,
          profileVersionId: id,
          calibrationScenarioId: scenario.id,
          definition: generation.agentEngine.twinDefinition,
          createdAt,
        });
      }
      return { created: true, versionId: id, version, personaContext: context };
    });
    await this.generateCalibrationPredictions(
      result.versionId,
      result.personaContext,
      generation,
    );
    await this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${memberId}))`,
      );
      const state = (
        await transaction
          .select()
          .from(portraitMemberStates)
          .where(eq(portraitMemberStates.memberId, memberId))
          .limit(1)
      )[0];
      const currentVersion = state
        ? (
            await transaction
              .select({ version: portraitVersions.version })
              .from(portraitVersions)
              .where(eq(portraitVersions.id, state.submittedVersionId))
              .limit(1)
          )[0]?.version
        : undefined;
      if (currentVersion !== undefined && currentVersion > result.version) return;
      await transaction
        .insert(portraitMemberStates)
        .values({
          memberId,
          submittedVersionId: result.versionId,
          publishedVersionId: null,
          updatedAt: this.now(),
        })
        .onConflictDoUpdate({
          target: portraitMemberStates.memberId,
          set: { submittedVersionId: result.versionId, updatedAt: this.now() },
        });
    });
    return { ...result, state: await this.memberState(memberId) };
  }

  async interviewState(memberId: string) {
    const [answerCount, draft] = await Promise.all([
      this.db
        .select({ value: count() })
        .from(portraitFixedAnswers)
        .where(eq(portraitFixedAnswers.memberId, memberId)),
      this.db
        .select({ completedDimensions: portraitDrafts.completedDimensions })
        .from(portraitDrafts)
        .where(eq(portraitDrafts.memberId, memberId))
        .limit(1),
    ]);
    return visibleState(
      memberId,
      Number(answerCount[0]?.value ?? 0),
      draft[0]?.completedDimensions ?? 0,
    );
  }

  async fixedInterviewComplete(memberId: string) {
    const state = await this.interviewState(memberId);
    return state.fixedInterview.completed;
  }

  async submitFixedAnswer(
    memberId: string,
    input: FixedAnswerInput,
    autoFollowup: AutoFollowupOptions,
  ) {
    const question = FIXED_INTERVIEW_QUESTIONS.find(
      (candidate) => candidate.id === input.questionId,
    );
    if (!question) throw new PortraitInputError("FIXED_QUESTION_NOT_FOUND");
    const selected = [...new Set(input.selectedOptionIds)];
    const allowed = new Set<string>(question.options.map((option) => option.id));
    const freeText = input.freeText.trim();
    if (
      selected.length !== input.selectedOptionIds.length ||
      selected.some((id) => !allowed.has(id)) ||
      (input.noneApplies && selected.length > 0) ||
      (!input.noneApplies && selected.length === 0 && !freeText)
    ) {
      throw new PortraitInputError("INVALID_FIXED_ANSWER");
    }

    let followupJob:
      | Awaited<ReturnType<AgentJobs["enqueueInterview"]>>
      | undefined;
    await this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${memberId}))`,
      );
      const existing = (
        await transaction
          .select({
            questionId: portraitFixedAnswers.questionId,
            messageId: portraitFixedAnswers.messageId,
          })
          .from(portraitFixedAnswers)
          .where(
            and(
              eq(portraitFixedAnswers.memberId, memberId),
              eq(portraitFixedAnswers.questionId, input.questionId),
            ),
          )
          .limit(1)
      )[0];
      if (existing) {
        if (
          input.questionId ===
          FIXED_INTERVIEW_QUESTIONS.at(-1)!.id
        ) {
          const message = await this.interviewConversations.conversationForMessage(
            transaction,
            existing.messageId,
          );
          if (message) {
            followupJob = await autoFollowup.agentJobs.enqueueInterview({
              transaction,
              memberId,
              conversationId: message.conversationId,
              inputMessageId: existing.messageId,
              definition: autoFollowup.definition,
              createdAt: this.now(),
            });
          }
        }
        return;
      }

      const answers = await transaction
        .select({ questionId: portraitFixedAnswers.questionId })
        .from(portraitFixedAnswers)
        .where(eq(portraitFixedAnswers.memberId, memberId))
        .orderBy(asc(portraitFixedAnswers.createdAt));
      if (FIXED_INTERVIEW_QUESTIONS[answers.length]?.id !== input.questionId) {
        throw new PortraitInputError("FIXED_QUESTION_OUT_OF_ORDER");
      }

      const savedAt = this.now();
      const chosen = question.options
        .filter((option) => selected.includes(option.id))
        .map((option) => option.text);
      const content = [
        `固定访谈 ${answers.length + 1}/${FIXED_INTERVIEW_QUESTIONS.length}：${question.prompt}`,
        input.noneApplies ? "回答：都不符合" : `回答：${chosen.join("；")}`,
        freeText ? `补充：${freeText}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const message = await this.interviewConversations.appendFixedAnswer(
        transaction,
        memberId,
        content,
        savedAt,
      );
      await transaction.insert(portraitFixedAnswers).values({
        memberId,
        questionId: input.questionId,
        selectedOptionIds: selected,
        noneApplies: input.noneApplies,
        freeText,
        messageId: message.id,
        createdAt: savedAt,
      });
      if (answers.length + 1 === FIXED_INTERVIEW_QUESTIONS.length) {
        followupJob = await autoFollowup.agentJobs.enqueueInterview({
          transaction,
          memberId,
          conversationId: message.conversationId,
          inputMessageId: message.id,
          definition: autoFollowup.definition,
          createdAt: savedAt,
        });
      }
    });

    return { state: await this.interviewState(memberId), followupJob };
  }

  async draftForInterviewer(memberId: string, latestMessage: string) {
    const draft = (
      await this.db
        .select()
        .from(portraitDrafts)
        .where(eq(portraitDrafts.memberId, memberId))
        .limit(1)
    )[0];
    const content = draft?.content ?? emptyPortraitDraft();
    const commonWeaknessIndex = [...memberId].reduce(
      (sum, character) => sum + character.codePointAt(0)!,
      0,
    );
    return {
      portraitDraft: content,
      questionPlannerVersion: QUESTION_PLANNER_VERSION,
      planningPriority: interviewPlanningPriority(
        content,
        latestMessage,
        commonWeaknessIndex,
      ),
    };
  }

  async extractDraft(
    memberId: string,
    conversationId: string,
    throughSequence: number,
    agentEngine: AgentEngine,
    recordAttempts: (attempts: AgentAttemptResult[]) => Promise<void>,
  ) {
    const [savedDraft, messages] = await Promise.all([
      this.db
        .select()
        .from(portraitDrafts)
        .where(eq(portraitDrafts.memberId, memberId))
        .limit(1),
      this.interviewConversations.memberEvidence(
        conversationId,
        throughSequence,
      ),
    ]);
    const current = savedDraft[0];
    const newEvidence = messages.filter(
      (message) => message.sequence > (current?.lastMessageSequence ?? 0),
    );
    if (!newEvidence.length) {
      return {
        completed: current?.completedDimensions ?? 0,
        newlyConfident: false,
      };
    }

    const prompt = portraitExtractionPrompt(
      current?.content ?? emptyPortraitDraft(),
      newEvidence,
    );
    let attempts: AgentAttemptResult[] = [];
    try {
      const extracted = await agentEngine.extractPortrait(
        prompt,
        portraitDraftSchema,
        async () => undefined,
      );
      attempts = extracted.attempts;
      const content = extracted.value as PortraitDraftContent;
      const validEvidence = new Set(messages.map((message) => message.id));
      const newEvidenceIds = new Set(newEvidence.map((message) => message.id));
      const previousContent = current?.content ?? emptyPortraitDraft();
      const assessment = assessPortraitDraft(
        content,
        previousContent,
        validEvidence,
        newEvidenceIds,
      );
      if (!assessment.valid) {
        attempts.at(-1)!.error = "PORTRAIT_EVIDENCE_INVALID";
        throw new AgentRunError("PORTRAIT_EVIDENCE_INVALID", attempts);
      }
      await recordAttempts(attempts);
      const completed = assessment.completed;
      const savedAt = this.now();
      await this.db
        .insert(portraitDrafts)
        .values({
          memberId,
          schemaVersion: PORTRAIT_SCHEMA_VERSION,
          plannerVersion: QUESTION_PLANNER_VERSION,
          content,
          completedDimensions: completed,
          lastMessageSequence: throughSequence,
          createdAt: current?.createdAt ?? savedAt,
          updatedAt: savedAt,
        })
        .onConflictDoUpdate({
          target: portraitDrafts.memberId,
          set: {
            schemaVersion: PORTRAIT_SCHEMA_VERSION,
            plannerVersion: QUESTION_PLANNER_VERSION,
            content,
            completedDimensions: completed,
            lastMessageSequence: throughSequence,
            updatedAt: savedAt,
          },
        });
      return {
        completed,
        newlyConfident: assessment.newlyConfident,
      };
    } catch (error) {
      if (error instanceof AgentRunError) attempts = error.attempts;
      await recordAttempts(attempts);
      throw error;
    }
  }
}
