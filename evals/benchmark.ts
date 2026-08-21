import assert from "node:assert/strict";
import { readConfig } from "../server/src/config.js";
import { loadRootEnv } from "../server/src/env.js";
import {
  AgentEngine,
  type AgentAttemptResult,
} from "../server/src/modules/agent-engine/engine.js";
import { PORTRAIT_DIMENSIONS } from "../server/src/modules/portraits/questions.js";
import {
  assessPortraitDraft,
  emptyPortraitDraft,
  portraitDraftSchema,
  portraitExtractionPrompt,
} from "../server/src/modules/portraits/service.js";
import {
  extractionCases,
  interviewCases,
  type ExtractionCase,
  type InterviewCase,
} from "./check.js";

const HIDDEN_OUTPUT =
  /portraitDraft|selfTendency|partnerExpectation|hardBoundary|evidenceMessageIds|置信度|画像草稿|证据消息/;

const totals = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  latencyMs: 0,
  estimatedCostMicroCny: 0,
};

function collect(attempts: AgentAttemptResult[]) {
  for (const attempt of attempts) {
    totals.calls += 1;
    totals.inputTokens += attempt.inputTokens;
    totals.outputTokens += attempt.outputTokens;
    totals.latencyMs += attempt.latencyMs;
    totals.estimatedCostMicroCny += attempt.estimatedCostMicroCny;
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

loadRootEnv();
const config = readConfig();
assert(
  config.agentModel,
  "Ark benchmark requires ARK_API_KEY, ARK_MODEL_ID and pricing configuration",
);
const engine = new AgentEngine(config.agentModel, config.agentInputTokenBudget);
try {
  for (const item of interviewCases) await benchmarkInterview(engine, item);
  for (const item of extractionCases) await benchmarkExtraction(engine, item);
} finally {
  engine.close();
}

console.info(
  `portrait benchmark ok: ${interviewCases.length + extractionCases.length} cases, ` +
    `${totals.calls} calls, ${totals.inputTokens}/${totals.outputTokens} tokens, ` +
    `${totals.latencyMs}ms, ¥${(totals.estimatedCostMicroCny / 1_000_000).toFixed(6)}`,
);
