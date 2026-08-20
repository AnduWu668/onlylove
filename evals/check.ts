import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  FIXED_INTERVIEW_QUESTIONS,
  PORTRAIT_DIMENSIONS,
  publicQuestion,
} from "../server/src/modules/portraits/questions.js";
import {
  assessPortraitDraft,
  emptyPortraitDraft,
  interviewPlanningPriority,
} from "../server/src/modules/portraits/service.js";

const load = async (name: string) =>
  JSON.parse(await readFile(new URL(name, import.meta.url), "utf8")) as any[];
const interview = await load("interview-cases.json");
const extraction = await load("extraction-cases.json");

assert.equal(FIXED_INTERVIEW_QUESTIONS.length, 10);
assert.deepEqual(
  new Set(FIXED_INTERVIEW_QUESTIONS.flatMap((item) => item.dimensions)),
  new Set(PORTRAIT_DIMENSIONS),
);
for (const [index, question] of FIXED_INTERVIEW_QUESTIONS.entries()) {
  assert(question.options.length >= 3 && question.options.length <= 4);
  assert(!question.options.some((option) => /优质|正确|错误|推荐/.test(option.text)));
  assert.notDeepEqual(
    publicQuestion("benchmark-member-a", index)?.options,
    publicQuestion("benchmark-member-b", index)?.options,
  );
}

const lowDraft = emptyPortraitDraft();
assert.equal(
  interviewPlanningPriority(lowDraft, "这不像我，请先纠正。", 0),
  "member_correction",
);
assert.match(interviewPlanningPriority(lowDraft, "继续", 0), /^low_confidence:/);
const confidentDraft = emptyPortraitDraft();
for (const value of Object.values(confidentDraft)) value.confidence = "high";
confidentDraft.values.contradictions = ["同一边界在两个场景中不同"];
assert.equal(
  interviewPlanningPriority(confidentDraft, "继续", 8),
  "contradiction:values",
);
confidentDraft.values.contradictions = [];
assert.match(
  interviewPlanningPriority(confidentDraft, "继续", 8),
  /^published_common_weakness:/,
);

const extracted = emptyPortraitDraft();
extracted.values.confidence = "medium";
extracted.values.evidenceMessageIds = ["known-message"];
assert.deepEqual(
  assessPortraitDraft(
    extracted,
    emptyPortraitDraft(),
    new Set(["known-message"]),
    new Set(["known-message"]),
  ),
  { valid: true, completed: 1, newlyConfident: true },
);
assert.equal(
  assessPortraitDraft(
    extracted,
    emptyPortraitDraft(),
    new Set(),
    new Set(["known-message"]),
  ).valid,
  false,
);

const hallucinationCase = extraction.find(
  (item) => item.category === "fact_hallucination",
)!;
for (const candidate of hallucinationCase.candidateOutputs) {
  const passed = !hallucinationCase.forbiddenClaims.some((claim: string) =>
    candidate.text.includes(claim),
  );
  assert.equal(passed, candidate.shouldPass);
}

for (const category of [
  "leading_options",
  "correction",
  "low_confidence",
  "contradiction",
]) {
  assert(interview.some((item) => item.category === category), `missing ${category}`);
}
for (const category of [
  "eight_dimensions",
  "evidence_reference",
  "fact_hallucination",
]) {
  assert(extraction.some((item) => item.category === category), `missing ${category}`);
}

console.info(`portrait benchmark ok: ${interview.length + extraction.length} cases`);
