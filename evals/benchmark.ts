import assert from "node:assert/strict";
import { readConfig } from "../server/src/config.js";
import { loadRootEnv } from "../server/src/env.js";
import {
  AgentEngine,
  type AgentAttemptResult,
} from "../server/src/modules/agent-engine/engine.js";
import {
  matchEvaluatorDefinition,
  portraitExtractorDefinition,
} from "../server/src/modules/agent-engine/definitions.js";
import { PORTRAIT_DIMENSIONS } from "../server/src/modules/portraits/questions.js";
import { PAIR_EVALUATION_SCHEMA_VERSION } from "../server/src/modules/matching/evaluation.js";
import {
  assessPortraitDraft,
  emptyPortraitDraft,
  portraitDraftSchema,
  portraitExtractionPrompt,
} from "../server/src/modules/portraits/service.js";
import {
  extractionCases,
  interviewCases,
  twinCases,
  twinOutputViolations,
  type ExtractionCase,
  type InterviewCase,
  type TwinCase,
} from "./check.js";
import {
  PORTRAIT_FEATURE_FIELDS,
  portraitLearningEvidence,
  portraitLearningSuite,
  scorePortraitFeatures,
  type PortraitFeatureScore,
  type PortraitLearningCase,
} from "./portrait-learning.js";
import {
  assertMatchingRanking,
  assertMatchingResult,
  matchingInput,
  matchingModelOutput,
  matchingSuite,
  type MatchingCase,
} from "./matching.js";

const HIDDEN_OUTPUT =
  /portraitDraft|selfTendency|partnerExpectation|hardBoundary|evidenceMessageIds|置信度|画像草稿|证据消息/;

const totals = {
  calls: 0,
  failedAttempts: 0,
  inputTokens: 0,
  outputTokens: 0,
  latencyMs: 0,
  firstTokenLatencyMs: 0,
  firstTokenSamples: 0,
  estimatedCostMicroCny: 0,
  retryAttempts: 0,
  switchedAttempts: 0,
};

function collect(attempts: AgentAttemptResult[]) {
  for (const attempt of attempts) {
    totals.calls += 1;
    totals.failedAttempts += Number(Boolean(attempt.error));
    totals.inputTokens += attempt.inputTokens;
    totals.outputTokens += attempt.outputTokens;
    totals.latencyMs += attempt.latencyMs;
    if (attempt.firstTokenLatencyMs !== null) {
      totals.firstTokenLatencyMs += attempt.firstTokenLatencyMs;
      totals.firstTokenSamples += 1;
    }
    totals.estimatedCostMicroCny += attempt.estimatedCostMicroCny;
    totals.retryAttempts += Number(attempt.retryCount > 0);
    totals.switchedAttempts += Number(attempt.switchedModel);
  }
}

function referenceOptions(item: InterviewCase) {
  assert(item.referenceOptions, `${item.id}: referenceOptions are required`);
  return item.referenceOptions;
}

function assertInterviewInvariant(
  item: InterviewCase,
  invariant: string,
  output: string,
) {
  switch (invariant) {
    case "three_to_four_options": {
      const options = referenceOptions(item);
      assert(options.length >= 3 && options.length <= 4, `${item.id}: option count`);
      return;
    }
    case "no_quality_labels":
      assert(!referenceOptions(item).some((option) => /优质|正确|错误|推荐/.test(option)), `${item.id}: leading quality label`);
      return;
    case "mixed_realistic_tendencies": {
      const options = referenceOptions(item);
      assert.equal(new Set(options).size, options.length, `${item.id}: duplicate tendency`);
      return;
    }
    case "clarify_correction_before_other_topics":
      assert.match(output, /不像|害怕冲突|想清楚|理解|确认|核对|澄清/, `${item.id}: correction was not addressed`);
      return;
    case "one_focus_only":
      assert.equal((output.match(/[？?]/g) ?? []).length, 1, `${item.id}: expected one question`);
      return;
    case "ask_low_confidence_dimension":
      assert.match(output, /生活|日常|作息|节奏|工作日|晚上|时间安排/, `${item.id}: low-confidence topic was missed`);
      return;
    case "do_not_repeat_high_confidence_topic":
      assert.doesNotMatch(output, /价值观/, `${item.id}: repeated high-confidence topic`);
      return;
    case "name_context_without_judgement":
      assert.match(output, /独立|空间|行程|分享/, `${item.id}: contradictory context was missed`);
      assert.doesNotMatch(output, /你很矛盾|控制欲|依赖型|有问题/, `${item.id}: judgemental wording`);
      return;
    case "ask_for_difference_between_situations":
      assert.match(output, /情况|情境|场景|什么时候|哪些时候|差别|不同/, `${item.id}: did not compare situations`);
      return;
    default:
      assert.fail(`${item.id}: unsupported invariant ${invariant}`);
  }
}

function planningPriority(category: InterviewCase["category"]) {
  switch (category) {
    case "correction":
      return "member_correction";
    case "low_confidence":
      return "low_confidence:lifestyle";
    case "contradiction":
      return "contradiction:relationship_boundaries";
    case "leading_options":
      return "published_common_weakness:preference_vs_boundary";
  }
}

function portraitDraftFor(item: InterviewCase) {
  const draft = emptyPortraitDraft();
  if (item.category === "low_confidence") {
    for (const dimension of Object.values(draft)) dimension.confidence = "high";
    draft.lifestyle.confidence = "low";
  }
  if (item.category === "contradiction") {
    for (const dimension of Object.values(draft)) dimension.confidence = "high";
    draft.relationship_boundaries.selfTendency = "希望保持独立";
    draft.relationship_boundaries.contradictions = [
      "希望完全独立，但伴侣不分享行程时会不安",
    ];
  }
  return draft;
}

async function benchmarkInterview(engine: AgentEngine, item: InterviewCase) {
  if (item.category === "leading_options") {
    for (const invariant of item.invariants) {
      assertInterviewInvariant(item, invariant, "");
    }
    console.info(`PASS interview/${item.id} (deterministic options)`);
    return;
  }

  const result = await engine.continueInterview(
    {
      memberProfile: {
        nickname: "测试成员",
        birthDate: "1990-01-01",
        gender: "",
        heightCm: null,
        city: "",
        occupation: "",
      },
      matchCriteria: null,
      portraitDraft: portraitDraftFor(item),
      questionPlannerVersion: "portrait-question-planner-v1",
      planningPriority: planningPriority(item.category),
      recentMessages: [],
    },
    item.input,
    () => undefined,
    async () => undefined,
  );
  assert(result.text.trim(), `${item.id}: empty response`);
  assert.doesNotMatch(result.text, HIDDEN_OUTPUT, `${item.id}: hidden internals leaked`);
  for (const invariant of item.invariants) {
    assertInterviewInvariant(item, invariant, result.text);
  }
  collect(result.attempts);
  console.info(`PASS interview/${item.id} model=${result.actualModel}`);
}

function assertExtractionInvariant(
  item: ExtractionCase,
  invariant: string,
  content: ReturnType<typeof emptyPortraitDraft>,
) {
  const evidenceIds = new Set(item.evidenceMessages.map((message) => message.id));
  const assessment = assessPortraitDraft(
    content,
    emptyPortraitDraft(),
    evidenceIds,
    evidenceIds,
  );
  switch (invariant) {
    case "all_dimensions_present":
      assert.deepEqual(new Set(Object.keys(content)), new Set(PORTRAIT_DIMENSIONS), `${item.id}: incomplete dimensions`);
      return;
    case "missing_information_stays_low_confidence":
      assert(Object.values(content).every((dimension) => dimension.confidence === "low" && dimension.evidenceMessageIds.length === 0), `${item.id}: invented confidence without evidence`);
      return;
    case "medium_or_high_has_evidence":
      assert(assessment.valid, `${item.id}: confident claim has no valid evidence`);
      assert(assessment.completed > 0, `${item.id}: clear evidence was not extracted`);
      return;
    case "evidence_id_exists_in_input":
      assert(assessment.valid, `${item.id}: unknown evidence id`);
      return;
    case "unknown_stays_unknown":
    case "no_unsupported_fact": {
      assert("forbiddenClaims" in item, `${item.id}: forbiddenClaims are required`);
      const serialized = JSON.stringify(content);
      for (const claim of item.forbiddenClaims) {
        assert(!serialized.includes(claim), `${item.id}: unsupported claim: ${claim}`);
      }
      return;
    }
    default:
      assert.fail(`${item.id}: unsupported invariant ${invariant}`);
  }
}

async function benchmarkExtraction(engine: AgentEngine, item: ExtractionCase) {
  const current = emptyPortraitDraft();
  const result = await engine.extractPortrait(
    portraitExtractionPrompt(current, item.evidenceMessages),
    portraitDraftSchema,
    async () => undefined,
  );
  for (const invariant of item.invariants) {
    assertExtractionInvariant(item, invariant, result.value);
  }
  collect(result.attempts);
  console.info(
    `PASS extraction/${item.id} model=${result.attempts.at(-1)?.actualModel}`,
  );
}

async function benchmarkTwin(engine: AgentEngine, item: TwinCase) {
  const result = await engine.replyAsTwin(
    {
      personaContext: item.personaContext,
      publicProfile: {
        nickname: "测试成员",
        birthDate: "1990-01-01",
        gender: "female",
        heightCm: 165,
        city: "上海",
        occupation: "设计师",
      },
      recentMessages: item.recentMessages,
    },
    item.input,
    undefined,
    async () => undefined,
  );
  assert(result.text.trim(), `${item.id}: empty response`);
  assert.deepEqual(
    twinOutputViolations(item, result.text),
    [],
    `${item.id}: twin invariant failed`,
  );
  collect(result.attempts);
  console.info(`PASS twin/${item.id} model=${result.actualModel}`);
}

function longHistory(prefix: string, markers: string[]) {
  const markerByIndex = new Map([
    [4, markers[0]],
    [34, markers[1]],
    [50, markers[2]],
  ]);
  const filler = "这是一段用于上下文长度实验的中性对话记录。".repeat(40);
  return Array.from({ length: 60 }, (_, index) => ({
    role: index % 2 === 0 ? ("member" as const) : ("agent" as const),
    content: `${prefix}${index + 1}：${markerByIndex.get(index) ?? "没有新增代号。"}${filler}`,
  }));
}

function logContextResult(
  role: "interview" | "twin",
  markers: string[],
  text: string,
  attempts: AgentAttemptResult[],
) {
  const attempt = attempts.at(-1)!;
  const recalled = markers.filter((marker) => text.includes(marker)).length;
  console.info(
    `RESULT context/${role} quality=${recalled}/${markers.length} ` +
      `input_tokens=${attempt.inputTokens} output_tokens=${attempt.outputTokens} ` +
      `latency_ms=${attempt.latencyMs} first_token_ms=${attempt.firstTokenLatencyMs} ` +
      `cost_micro_cny=${attempt.estimatedCostMicroCny} model=${attempt.actualModel}`,
  );
}

async function benchmarkLongContext(engine: AgentEngine) {
  const interviewMarkers = ["访谈代号-青石", "访谈代号-远帆", "访谈代号-暖灯"];
  const interview = await engine.continueInterview(
    {
      memberProfile: {
        nickname: "长上下文成员",
        birthDate: "1990-01-01",
        gender: "female",
        heightCm: 165,
        city: "上海",
        occupation: "设计师",
      },
      matchCriteria: null,
      portraitDraft: emptyPortraitDraft(),
      questionPlannerVersion: "portrait-question-planner-v1",
      planningPriority: "long_context_recall",
      recentMessages: longHistory("访谈记录", interviewMarkers),
    },
    "请只列出我在此前访谈中明确说过的三个访谈代号；没看到的不要猜。",
    () => undefined,
    async () => undefined,
  );
  collect(interview.attempts);
  logContextResult("interview", interviewMarkers, interview.text, interview.attempts);

  const twinMarkers = ["分身代号-云桥", "分身代号-松风", "分身代号-星河"];
  const twin = await engine.replyAsTwin(
    {
      personaContext: "只依据已提供的信息回答；不知道时明确说不知道。",
      publicProfile: null,
      recentMessages: longHistory("分身会话", twinMarkers),
    },
    "请只列出访客在此前会话中明确说过的三个分身代号；没看到的不要猜。",
    undefined,
    async () => undefined,
  );
  collect(twin.attempts);
  logContextResult("twin", twinMarkers, twin.text, twin.attempts);
}

async function extractPortrait(
  engine: AgentEngine,
  current: ReturnType<typeof emptyPortraitDraft>,
  evidence: ReturnType<typeof portraitLearningEvidence>,
) {
  const result = await engine.extractPortrait(
    portraitExtractionPrompt(current, evidence),
    portraitDraftSchema,
    async () => undefined,
  );
  collect(result.attempts);
  return result;
}

async function benchmarkPortraitLearning(
  engine: AgentEngine,
  item: PortraitLearningCase,
) {
  const evidence = portraitLearningEvidence(item);
  const fixedEvidence = evidence.slice(0, 10);
  const dialogueEvidence = evidence.slice(10);
  const baseline = await extractPortrait(
    engine,
    emptyPortraitDraft(),
    fixedEvidence,
  );
  const refined = await extractPortrait(
    engine,
    baseline.value,
    dialogueEvidence,
  );
  const baselineScore = scorePortraitFeatures(
    baseline.value,
    item.gold,
    new Set(fixedEvidence.map((message) => message.id)),
  );
  const refinedScore = scorePortraitFeatures(
    refined.value,
    item.gold,
    new Set(evidence.map((message) => message.id)),
  );
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  console.info(
    `RESULT portrait-learning/${item.id} ` +
      `fixed10_f1=${percent(baselineScore.f1)} ` +
      `refined_f1=${percent(refinedScore.f1)} ` +
      `delta=${percent(refinedScore.f1 - baselineScore.f1)} ` +
      `model=${refined.attempts.at(-1)?.actualModel}`,
  );
  if (refinedScore.missedFeatures.length) {
    console.info(`  missed: ${refinedScore.missedFeatures.join(", ")}`);
  }
  if (refinedScore.unexpectedFeatures.length) {
    console.info(
      `  unexpected: ${refinedScore.unexpectedFeatures.join(" | ")}`,
    );
  }
  if (refinedScore.vetoes.length) {
    console.info(`  VETO: ${refinedScore.vetoes.join(", ")}`);
  }
  return { baselineScore, refinedScore };
}

function summarizeFeatureScores(scores: PortraitFeatureScore[]) {
  const sum = (
    field:
      | "truePositive"
      | "falsePositive"
      | "falseNegative"
      | "trueNegative",
  ) => scores.reduce((total, score) => total + score[field], 0);
  const truePositive = sum("truePositive");
  const falsePositive = sum("falsePositive");
  const falseNegative = sum("falseNegative");
  const trueNegative = sum("trueNegative");
  const precision = truePositive / (truePositive + falsePositive || 1);
  const recall = truePositive / (truePositive + falseNegative || 1);
  return {
    precision,
    recall,
    f1: (2 * precision * recall) / (precision + recall || 1),
    slotAccuracy:
      (truePositive + trueNegative) /
      (scores.length *
        PORTRAIT_DIMENSIONS.length *
        PORTRAIT_FEATURE_FIELDS.length),
    vetoes: scores.flatMap((score) => score.vetoes),
  };
}

async function benchmarkMatching(
  engine: AgentEngine | undefined,
  item: MatchingCase,
  deterministic: boolean,
) {
  const currentEngine = deterministic
    ? new AgentEngine({
        provider: "deterministic-fake",
        model: "matching-deterministic-v0",
        reply: JSON.stringify(matchingModelOutput(item)),
      })
    : engine;
  assert(currentEngine, "matching benchmark engine is required");
  try {
    const result = await currentEngine.evaluatePair(
      matchingInput(item),
      async () => undefined,
    );
    assertMatchingResult(item, result.value);
    collect(result.attempts);
    console.info(
      `PASS matching/${item.id} reciprocal=${result.value.reciprocalScore} ` +
        `eligibility=${result.value.eligibility} provider=${result.attempts.at(-1)?.provider} ` +
        `requested_model=${result.attempts.at(-1)?.requestedModel} actual_model=${result.attempts.at(-1)?.actualModel} ` +
        `tokens=${result.attempts.at(-1)?.inputTokens}/${result.attempts.at(-1)?.outputTokens} ` +
        `latency_ms=${result.attempts.at(-1)?.latencyMs} first_token_ms=${result.attempts.at(-1)?.firstTokenLatencyMs} ` +
        `cost_micro_cny=${result.attempts.at(-1)?.estimatedCostMicroCny}`,
    );
    return { item, result: result.value };
  } finally {
    if (deterministic) currentEngine.close();
  }
}

loadRootEnv();
const interviewOnly = process.argv.includes("--interview");
const extractionOnly = process.argv.includes("--extraction");
const twinOnly = process.argv.includes("--twin");
const learningOnly = process.argv.includes("--portrait-learning");
const matchingOnly = process.argv.includes("--matching");
const contextOnly = process.argv.includes("--context");
const deterministic = process.argv.includes("--deterministic");
const selected =
  interviewOnly ||
  extractionOnly ||
  twinOnly ||
  learningOnly ||
  matchingOnly ||
  contextOnly;
assert(
  !deterministic || matchingOnly,
  "deterministic mode currently supports the matching benchmark",
);
const config = deterministic ? undefined : readConfig();
assert(
  deterministic || config?.agentModel,
  "Ark benchmark requires ARK_API_KEY, ARK_MODEL_ID and pricing configuration",
);
const engine = config?.agentModel
  ? new AgentEngine(config.agentModel, config.agentInputTokenBudget)
  : undefined;
console.info(
  `benchmark config: portrait_dataset=${portraitLearningSuite.schemaVersion}, ` +
    `matching_dataset=${matchingSuite.schemaVersion}, ` +
    `matching_rubric=${matchingSuite.rubricVersion}, ` +
    `matching_schema=${PAIR_EVALUATION_SCHEMA_VERSION}, ` +
    `matching_prompt=${matchEvaluatorDefinition.promptVersion}, ` +
    `matching_prompt_file=${matchEvaluatorDefinition.promptFile}, ` +
    `portrait_prompt=${portraitExtractorDefinition.promptVersion}, ` +
    `requested_model=${config?.agentModel?.model ?? "matching-deterministic-v0"}, ` +
    `input_budget=${config?.agentInputTokenBudget ?? "deterministic"}, ` +
    `pricing_date=${config?.agentModel?.pricing.effectiveDate ?? "none"}`,
);
let caseCount = 0;
try {
  if (!selected || interviewOnly) {
    assert(engine);
    for (const item of interviewCases) await benchmarkInterview(engine, item);
    caseCount += interviewCases.length;
  }
  if (!selected || extractionOnly) {
    assert(engine);
    for (const item of extractionCases) await benchmarkExtraction(engine, item);
    caseCount += extractionCases.length;
  }
  if (!selected || twinOnly) {
    assert(engine);
    for (const item of twinCases) await benchmarkTwin(engine, item);
    caseCount += twinCases.length;
  }
  if (!selected || learningOnly) {
    assert(engine);
    const portraitLearningResults = [];
    for (const item of portraitLearningSuite.cases) {
      portraitLearningResults.push(
        await benchmarkPortraitLearning(engine, item),
      );
    }
    caseCount += portraitLearningSuite.cases.length;
    const baseline = summarizeFeatureScores(
      portraitLearningResults.map((result) => result.baselineScore),
    );
    const refined = summarizeFeatureScores(
      portraitLearningResults.map((result) => result.refinedScore),
    );
    const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
    console.info(
      `portrait-learning summary: fixed10 ` +
        `P/R/F1=${percent(baseline.precision)}/${percent(baseline.recall)}/${percent(baseline.f1)}, ` +
        `10+dialogue P/R/F1=${percent(refined.precision)}/${percent(refined.recall)}/${percent(refined.f1)}, ` +
        `F1 delta=${percent(refined.f1 - baseline.f1)}, ` +
        `slot accuracy=${percent(refined.slotAccuracy)}`,
    );
    assert.equal(
      refined.vetoes.length,
      0,
      `portrait learning vetoes: ${refined.vetoes.join(", ")}`,
    );
  }
  if (!selected || matchingOnly) {
    const matchingResults = [];
    for (const item of matchingSuite.cases) {
      matchingResults.push(
        await benchmarkMatching(engine, item, deterministic),
      );
    }
    assertMatchingRanking(matchingResults, deterministic);
    caseCount += matchingSuite.cases.length;
  }
  if (contextOnly) {
    assert(engine);
    await benchmarkLongContext(engine);
    caseCount += 2;
  }
} finally {
  engine?.close();
}

console.info(
  `agent benchmark ok: ${caseCount} cases, ` +
    `${totals.calls} calls, ${totals.inputTokens}/${totals.outputTokens} tokens, ` +
    `${totals.latencyMs}ms, retries=${totals.retryAttempts}, errors=${totals.failedAttempts}, ` +
    `first_token_avg=${totals.firstTokenSamples ? Math.round(totals.firstTokenLatencyMs / totals.firstTokenSamples) : "n/a"}ms, ` +
    `switches=${totals.switchedAttempts}, ¥${(totals.estimatedCostMicroCny / 1_000_000).toFixed(6)}`,
);
