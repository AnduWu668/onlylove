import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
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

const nonemptyString = Type.String({ minLength: 1 });
const evidenceMessageSchema = Type.Object(
  {
    id: nonemptyString,
    content: nonemptyString,
    sequence: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
const interviewCaseSchema = Type.Object(
  {
    id: nonemptyString,
    category: Type.Union([
      Type.Literal("leading_options"),
      Type.Literal("correction"),
      Type.Literal("low_confidence"),
      Type.Literal("contradiction"),
    ]),
    input: nonemptyString,
    referenceOptions: Type.Optional(Type.Array(nonemptyString)),
    invariants: Type.Array(nonemptyString, { minItems: 1 }),
  },
  { additionalProperties: false },
);
const extractionCaseSchema = Type.Union([
  Type.Object(
    {
      id: nonemptyString,
      category: Type.Union([
        Type.Literal("eight_dimensions"),
        Type.Literal("evidence_reference"),
      ]),
      evidenceMessages: Type.Array(evidenceMessageSchema),
      invariants: Type.Array(nonemptyString, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: nonemptyString,
      category: Type.Literal("fact_hallucination"),
      evidenceMessages: Type.Array(evidenceMessageSchema),
      forbiddenClaims: Type.Array(nonemptyString, { minItems: 1 }),
      candidateOutputs: Type.Array(
        Type.Object(
          { text: nonemptyString, shouldPass: Type.Boolean() },
          { additionalProperties: false },
        ),
        { minItems: 1 },
      ),
      invariants: Type.Array(nonemptyString, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
]);

export type InterviewCase = Static<typeof interviewCaseSchema>;
export type ExtractionCase = Static<typeof extractionCaseSchema>;

async function loadCases<T extends TSchema>(name: string, itemSchema: T) {
  const value: unknown = JSON.parse(
    await readFile(new URL(name, import.meta.url), "utf8"),
  );
  const schema = Type.Array(itemSchema);
  const errors = [...Value.Errors(schema, value)];
  assert.equal(
    errors.length,
    0,
    errors
      .slice(0, 5)
      .map((error) => `${error.instancePath || "/"}: ${error.message}`)
      .join("; "),
  );
  return value as Static<T>[];
}

export const interviewCases = await loadCases(
  "interview-cases.json",
  interviewCaseSchema,
);
export const extractionCases = await loadCases(
  "extraction-cases.json",
  extractionCaseSchema,
);

assert.equal(FIXED_INTERVIEW_QUESTIONS.length, 10);
assert.deepEqual(
  new Set(FIXED_INTERVIEW_QUESTIONS.flatMap((item) => item.dimensions)),
  new Set(PORTRAIT_DIMENSIONS),
);
for (const [index, question] of FIXED_INTERVIEW_QUESTIONS.entries()) {
  assert(question.options.length >= 3 && question.options.length <= 4);
  assert(
    !question.options.some((option) =>
      /优质|正确|错误|推荐/.test(option.text),
    ),
  );
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
assert.equal(
  new Set(
    [0, 1, 2].map((index) =>
      interviewPlanningPriority(confidentDraft, "继续", index),
    ),
  ).size,
  3,
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

const hallucinationCase = extractionCases.find(
  (item) => item.category === "fact_hallucination",
);
assert(hallucinationCase?.category === "fact_hallucination");
for (const candidate of hallucinationCase.candidateOutputs) {
  const passed: boolean = !hallucinationCase.forbiddenClaims.some((claim) =>
    candidate.text.includes(claim),
  );
  assert.equal(passed, candidate.shouldPass);
}

for (const category of [
  "leading_options",
  "correction",
  "low_confidence",
  "contradiction",
] as const) {
  assert(
    interviewCases.some((item) => item.category === category),
    `missing ${category}`,
  );
}
for (const category of [
  "eight_dimensions",
  "evidence_reference",
  "fact_hallucination",
] as const) {
  assert(
    extractionCases.some((item) => item.category === category),
    `missing ${category}`,
  );
}

console.info(
  `portrait eval inputs ok: ${interviewCases.length + extractionCases.length} cases`,
);
