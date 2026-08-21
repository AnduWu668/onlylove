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
const CALIBRATION_JOB_HEARTBEAT_MS = 30 * 1_000;

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

interface CalibrationScenarioDefinition {
  dimensions: readonly PortraitDimension[];
  prompt: string;
}

const CALIBRATION_SCENARIO_SETS: readonly (
  readonly CalibrationScenarioDefinition[]
)[] = [
  [
    {
      dimensions: ["long_term_planning"],
      prompt: "你已接受本地长期项目，伴侣突然需要在两个月内决定是否去海外定居，你会怎样一起决定？",
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
      prompt: "伴侣忘记一项重要约定后已经道歉，但你担心还会发生，你会怎样修复信任？",
    },
    {
      dimensions: ["emotional_support"],
      prompt: "伴侣因一次工作失误很自责，却明确请你当作没发生，你会怎样支持？",
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
  [
    {
      dimensions: ["long_term_planning"],
      prompt: "伴侣想暂停工作一年去进修，而你们原本准备同期安家，你会怎样取舍？",
    },
    {
      dimensions: ["values"],
      prompt: "伴侣为了帮亲近的人而隐瞒一个会影响你的事实，你会怎么处理？",
    },
    {
      dimensions: ["relationship_boundaries"],
      prompt: "伴侣希望你减少与一位多年好友单独见面，你会怎样回应？",
    },
    {
      dimensions: ["communication"],
      prompt: "你发现一段文字沟通被伴侣理解成责备，会怎样澄清又不回避原问题？",
    },
    {
      dimensions: ["conflict_repair"],
      prompt: "伴侣已经道歉，但你觉得核心伤害仍没被理解，你会怎样继续修复？",
    },
    {
      dimensions: ["emotional_support"],
      prompt: "伴侣在重要公开活动前非常紧张，却不希望你陪同，你会怎样支持？",
    },
    {
      dimensions: ["lifestyle"],
      prompt: "你需要规律安静的早晨，伴侣却习惯在家一早开始社交和娱乐，会怎么协调？",
    },
    {
      dimensions: ["family_and_finance"],
      prompt: "伴侣想用共同储蓄支持一个高风险创业计划，你希望怎样决定？",
    },
    {
      dimensions: ["long_term_planning", "lifestyle"],
      prompt: "你们刚适应稳定生活，伴侣提出用半年跨城旅居来确认未来落脚点，你会怎样安排？",
    },
    {
      dimensions: ["relationship_boundaries", "emotional_support"],
      prompt: "伴侣在低谷时希望你暂时取消所有独处和朋友安排，你会怎样支持并守住边界？",
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

function generatedCalibrationScenarios(version: number, variant = 0) {
  // ponytail: bounded combinations cover hundreds of MVP versions without a
  // fifth Agent interface; add vocabularies if that ceiling becomes real.
  const seed = version + variant;
  const detail = Math.floor(seed / 4);
  const months = [3, 4, 6, 8, 9, 12][(detail * 5) % 6]!;
  const days = [2, 3, 5, 7, 10, 14][(detail * 5 + 1) % 6]!;
  const amount = [5, 8, 12, 18, 25, 30, 40][(detail * 3) % 7]!;
  const place = ["相邻城市", "沿海城市", "西部城市", "家乡", "省会", "海外城市"][
    (detail * 5 + 2) % 6
  ]!;
  const timing = ["春节前", "暑假开始时", "租约到期前", "项目收尾期", "家人需要照护时"][
    (detail * 2) % 5
  ]!;
  const families = [
    [
      {
        dimensions: ["long_term_planning"],
        prompt: `你们原定在 ${months} 个月内安定下来，伴侣却收到去${place}的长期项目机会，你会怎样一起决定？`,
      },
      {
        dimensions: ["values"],
        prompt: `伴侣想在${timing}把自己的 ${amount} 万元积蓄投入一项你有伦理疑虑的公益行动，你会怎么回应？`,
      },
      {
        dimensions: ["relationship_boundaries"],
        prompt: `伴侣去${place}出差期间希望你连续 ${days} 天共享实时位置，你会怎样协商边界？`,
      },
      {
        dimensions: ["communication"],
        prompt: `你们在${timing}讨论一笔 ${amount} 万元的共同计划时，伴侣把你的谨慎理解成不信任，你会怎样澄清？`,
      },
      {
        dimensions: ["conflict_repair"],
        prompt: `${timing}的一次争议后，你们约定在 ${days} 小时内重新谈，但伴侣没有出现，你会怎样继续修复？`,
      },
      {
        dimensions: ["emotional_support"],
        prompt: `伴侣从${timing}起要等待一项会影响未来 ${months} 个月的重要结果，并明确不想讨论，你会怎样支持？`,
      },
      {
        dimensions: ["lifestyle"],
        prompt: `伴侣在${place}的工作接下来 ${months} 个月需要长期上夜班，而你必须早起，你会怎样安排共同生活？`,
      },
      {
        dimensions: ["family_and_finance"],
        prompt: `伴侣家人希望在${timing}借用 ${amount} 万元且无法确定归还日期，你希望两个人怎样决定？`,
      },
      {
        dimensions: ["long_term_planning", "lifestyle"],
        prompt: `伴侣提议先在${place}用 ${months} 个月跨城生活来决定未来落脚点，但你更需要稳定日常，你会怎样取舍？`,
      },
      {
        dimensions: ["relationship_boundaries", "emotional_support"],
        prompt: `伴侣从${timing}起连续 ${days} 天承受压力，希望你取消个人安排随时陪伴，你会怎样支持并守住边界？`,
      },
    ],
    [
      {
        dimensions: ["long_term_planning"],
        prompt: `伴侣想在${timing}暂停工作 ${months} 个月去进修，而你需要留在${place}照护家人，你会怎样规划？`,
      },
      {
        dimensions: ["values"],
        prompt: `伴侣为了保护同事而隐瞒一项会让团队损失 ${amount} 万元的错误，你会怎样面对？`,
      },
      {
        dimensions: ["relationship_boundaries"],
        prompt: `伴侣希望你在搬去${place}前停止与一位多年好友单独见面 ${months} 个月，你会怎样回应？`,
      },
      {
        dimensions: ["communication"],
        prompt: `伴侣在家人面前误解并否定了你的决定，你只能在 ${days} 天后单独见面，会怎样沟通？`,
      },
      {
        dimensions: ["conflict_repair"],
        prompt: `伴侣忘记${timing}的一项重要约定，隔了 ${days} 天才道歉，你仍担心会重演，会怎样修复信任？`,
      },
      {
        dimensions: ["emotional_support"],
        prompt: `伴侣在${timing}的一次公开失误后只想恢复日常、不愿被安慰，你接下来 ${days} 天会怎样支持？`,
      },
      {
        dimensions: ["lifestyle"],
        prompt: `伴侣希望未来 ${months} 个月每周都在家聚会，而你需要安静和规律，会怎样协调？`,
      },
      {
        dimensions: ["family_and_finance"],
        prompt: `伴侣想承担在${place}读书的弟妹未来 ${months} 个月生活费，预计 ${amount} 万元，你希望怎样决定？`,
      },
      {
        dimensions: ["long_term_planning", "lifestyle"],
        prompt: `伴侣想搬到${place}追求理想生活，而你的职业与照护责任都在本地，你会怎样推进未来计划？`,
      },
      {
        dimensions: ["relationship_boundaries", "emotional_support"],
        prompt: `伴侣因焦虑希望查看你的私人日记来确认安全感，你会怎样安抚并守住边界？`,
      },
    ],
    [
      {
        dimensions: ["long_term_planning"],
        prompt: `你得到一份需要在${place}驻留 ${months} 个月的机会，但伴侣正准备在本地换职业，你会怎样决定？`,
      },
      {
        dimensions: ["values"],
        prompt: `伴侣打算在${timing}为亲近的人承担一项你认为不公平、价值 ${amount} 万元的责任，你会怎么处理分歧？`,
      },
      {
        dimensions: ["relationship_boundaries"],
        prompt: `伴侣在去${place}后常公开你们的争议，并希望内容至少保留 ${days} 天，你会怎样表达边界？`,
      },
      {
        dimensions: ["communication"],
        prompt: `一项需要在${timing}决定的共同事项已被伴侣回避 ${days} 天，你会怎样开启并推进对话？`,
      },
      {
        dimensions: ["conflict_repair"],
        prompt: `同一个矛盾在${timing}前的 ${months} 个月内再次发生，双方都觉得旧办法无效，你会怎样重新修复？`,
      },
      {
        dimensions: ["emotional_support"],
        prompt: `伴侣在${place}经历失去后希望你在 ${days} 天内不要改变日常、也不谈感受，你会怎样陪伴？`,
      },
      {
        dimensions: ["lifestyle"],
        prompt: `伴侣从${timing}起 ${months} 个月想频繁旅行，你却需要固定作息和独处，会怎样安排？`,
      },
      {
        dimensions: ["family_and_finance"],
        prompt: `你们收入将在 ${months} 个月内明显波动，同时有 ${amount} 万元家庭支出，会怎样做预算？`,
      },
      {
        dimensions: ["long_term_planning", "lifestyle"],
        prompt: `你们在${timing}必须决定继续高强度城市生活，还是搬去${place}换取更多相处时间，会怎样选择？`,
      },
      {
        dimensions: ["relationship_boundaries", "emotional_support"],
        prompt: `伴侣从${timing}起陷入低谷，要求你所有消息都在 ${days} 分钟内回复，你会怎样支持并协商空间？`,
      },
    ],
    [
      {
        dimensions: ["long_term_planning"],
        prompt: `伴侣想在${timing}投入 ${months} 个月创业，你们原定同期在${place}开始新生活，会怎样取舍？`,
      },
      {
        dimensions: ["values"],
        prompt: `伴侣为了在${timing}获得 ${amount} 万元机会而接受一项合法但你认为不诚实的安排，你会怎样回应？`,
      },
      {
        dimensions: ["relationship_boundaries"],
        prompt: `伴侣希望搬去${place}后双方把手机密码共享至少 ${months} 个月，你会怎样讨论信任与隐私？`,
      },
      {
        dimensions: ["communication"],
        prompt: `你在${timing}前必须说出一个可能改变${place}共同计划的决定，但伴侣正承受压力，你会怎样开口？`,
      },
      {
        dimensions: ["conflict_repair"],
        prompt: `伴侣在${timing}的聚会中让你难堪，隔了 ${days} 天仍认为只是玩笑，你会怎样让关系真正修复？`,
      },
      {
        dimensions: ["emotional_support"],
        prompt: `伴侣在${place}连续 ${days} 天过度工作却拒绝休息，也不希望你介入，你会怎样支持？`,
      },
      {
        dimensions: ["lifestyle"],
        prompt: `伴侣计划从${timing}起 ${months} 个月把大部分周末用于高强度训练，而你看重共同休息，会怎样协调？`,
      },
      {
        dimensions: ["family_and_finance"],
        prompt: `伴侣在${timing}获得 ${amount} 万元家庭赠与并想完全独立使用，你希望怎样讨论共同财务？`,
      },
      {
        dimensions: ["long_term_planning", "lifestyle"],
        prompt: `住在${place}能支持伴侣未来 ${months} 个月的目标，却会让你每天增加通勤并改变生活节奏，你会怎样决定？`,
      },
      {
        dimensions: ["relationship_boundaries", "emotional_support"],
        prompt: `伴侣因家庭危机希望你取消${timing}前 ${days} 天的全部个人承诺，你会怎样陪伴并保留必要边界？`,
      },
    ],
  ] as const satisfies readonly (readonly CalibrationScenarioDefinition[])[];
  return families[seed % families.length]!;
}

function normalizedQuestion(value: string) {
  return value.replace(/[\s，。！？、,.!?]/g, "").toLowerCase();
}

function calibrationScenarios(
  version: number,
  excludedPrompts: readonly string[],
) {
  const seen = new Set(excludedPrompts.map(normalizedQuestion));
  const base =
    CALIBRATION_SCENARIO_SETS[version - 1] ??
    generatedCalibrationScenarios(version);
  return base.map((scenario, index) => {
    let selected = scenario;
    let variant = 0;
    while (seen.has(normalizedQuestion(selected.prompt))) {
      variant += 1;
      if (variant > 2_000) {
        throw new PortraitInputError("CALIBRATION_SCENARIOS_EXHAUSTED");
      }
      selected = generatedCalibrationScenarios(version, variant)[index]!;
    }
    seen.add(normalizedQuestion(selected.prompt));
    return {
      id: randomUUID(),
      position: index + 1,
      dimensions: [...selected.dimensions],
      prompt: selected.prompt,
      prediction: null,
    };
  });
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
    private readonly agentJobs: AgentJobs,
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

    const [submitted, published, scenarios, answers, generationJobs] =
      await Promise.all([
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
        this.agentJobs.calibrationJobsForVersion(state.submittedVersionId),
      ]);
    const answerByScenario = new Map(
      answers.map((answer) => [answer.scenarioId, answer]),
    );
    const outcome = calibrationOutcome(answers, scenarios.length);
    const generationPending = scenarios.some(
      (scenario) => !scenario.prediction,
    );
    const generationFailed = generationJobs.some(
      (job) => job.status === "failed" && job.retryCount >= 3,
    );
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
        : generationFailed
          ? ("generation_failed" as const)
          : generationPending
            ? ("generating" as const)
            : outcome.passed
              ? ("ready_to_publish" as const)
              : outcome.complete
                ? ("needs_more_understanding" as const)
                : ("calibrating" as const),
      ...(generationFailed
        ? { message: "分身回答生成失败，请联系管理员重试" }
        : {}),
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
          prediction: scenario.prediction,
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
      if (!scenario.prediction) {
        throw new PortraitInputError("CALIBRATION_PREDICTION_PENDING");
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

  async processNextCalibrationJob(agentEngine: AgentEngine) {
    const candidate = await this.agentJobs.nextCalibrationJob(this.now());
    if (!candidate) return false;
    const startedAt = this.now();
    const claimed = await this.agentJobs.claim(
      candidate.id,
      startedAt,
      new Date(startedAt.getTime() + CALIBRATION_JOB_LEASE_MS),
      { retryFailed: true },
    );
    if (!claimed) return true;

    const heartbeat = setInterval(() => {
      const at = this.now();
      void this.agentJobs
        .heartbeat(
          claimed,
          new Date(at.getTime() + CALIBRATION_JOB_LEASE_MS),
        )
        .catch(() => undefined);
    }, CALIBRATION_JOB_HEARTBEAT_MS);
    heartbeat.unref();

    try {
      if (!claimed.profileVersionId || !claimed.calibrationScenarioId) {
        throw new Error("CALIBRATION_INPUT_MISSING");
      }
      const [version, scenario] = await Promise.all([
        this.db
          .select({ personaContext: portraitVersions.personaContext })
          .from(portraitVersions)
          .where(eq(portraitVersions.id, claimed.profileVersionId))
          .limit(1),
        this.db
          .select()
          .from(portraitCalibrationScenarios)
          .where(
            eq(
              portraitCalibrationScenarios.id,
              claimed.calibrationScenarioId,
            ),
          )
          .limit(1),
      ]);
      if (!version[0] || !scenario[0]) {
        throw new Error("CALIBRATION_INPUT_MISSING");
      }
      const result = await agentEngine.replyAsTwin(
        version[0].personaContext,
        scenario[0].prompt,
        (attempts) =>
          this.agentJobs.recordAttempts(
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
          .where(eq(portraitCalibrationScenarios.id, scenario[0]!.id));
        const completed = await this.agentJobs.complete(
          transaction,
          claimed,
          null,
          claimed.retryCount,
          result.switchedModel,
          this.now(),
        );
        if (!completed) throw new Error("AGENT_JOB_LEASE_LOST");
      });
    } catch (error) {
      const runError = error instanceof AgentRunError ? error : undefined;
      await this.db.transaction((transaction) =>
        this.agentJobs.fail(
          transaction,
          claimed,
          runError?.code ?? "MODEL_REQUEST_FAILED",
          claimed.retryCount + 1,
          claimed.switchedModel || (runError?.switchedModel ?? false),
          false,
          this.now(),
        ),
      );
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  async submitVersion(
    memberId: string,
    clientRequestId: string,
    generation: VersionGenerationOptions,
  ) {
    const excludedInterviewPrompts = [
      ...FIXED_INTERVIEW_QUESTIONS.map((question) => question.prompt),
      ...(
        await this.interviewConversations.agentQuestionsForMember(memberId)
      ).map((message) => message.content),
    ];
    const interviewConversationId =
      await this.interviewConversations.conversationIdForMember(
        memberId,
        "INTERVIEW",
      );
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
        };
      }

      if (interviewConversationId) {
        const latestJob = await generation.agentJobs.latestForConversation(
          interviewConversationId,
          transaction,
        );
        if (latestJob && ["pending", "running"].includes(latestJob.status)) {
          throw new PortraitInputError("PORTRAIT_DRAFT_UPDATING");
        }
        if (latestJob?.status === "failed") {
          throw new PortraitInputError("PORTRAIT_DRAFT_UPDATE_FAILED");
        }
      }

      const state = (
        await transaction
          .select()
          .from(portraitMemberStates)
          .where(eq(portraitMemberStates.memberId, memberId))
          .limit(1)
      )[0];
      if (state && state.publishedVersionId !== state.submittedVersionId) {
        const currentAnswers = await transaction
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
            eq(
              portraitCalibrationScenarios.portraitVersionId,
              state.submittedVersionId,
            ),
          );
        const outcome = calibrationOutcome(currentAnswers);
        if (!outcome.complete || outcome.passed) {
          throw new PortraitInputError("PORTRAIT_VERSION_IN_PROGRESS");
        }
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
      const previousScenarios = await transaction
        .select({ prompt: portraitCalibrationScenarios.prompt })
        .from(portraitCalibrationScenarios)
        .innerJoin(
          portraitVersions,
          eq(
            portraitVersions.id,
            portraitCalibrationScenarios.portraitVersionId,
          ),
        )
        .where(eq(portraitVersions.memberId, memberId));
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
      const scenarios = calibrationScenarios(version, [
        ...excludedInterviewPrompts,
        ...previousScenarios.map((scenario) => scenario.prompt),
      ]);
      await transaction.insert(portraitCalibrationScenarios).values(
        scenarios.map((scenario) => ({
          ...scenario,
          portraitVersionId: id,
          createdAt,
        })),
      );
      for (const scenario of scenarios) {
        await generation.agentJobs.enqueueTwinCalibration({
          transaction,
          memberId,
          profileVersionId: id,
          calibrationScenarioId: scenario.id,
          definition: generation.agentEngine.twinDefinition,
          createdAt,
        });
      }
      await transaction
        .insert(portraitMemberStates)
        .values({
          memberId,
          submittedVersionId: id,
          publishedVersionId: null,
          updatedAt: this.now(),
        })
        .onConflictDoUpdate({
          target: portraitMemberStates.memberId,
          set: { submittedVersionId: id, updatedAt: this.now() },
        });
      return { created: true, versionId: id, version };
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
