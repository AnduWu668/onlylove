import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  FIXED_INTERVIEW_QUESTIONS,
  PORTRAIT_DIMENSIONS,
  type PortraitDimension,
} from "../server/src/modules/portraits/questions.js";
import type { PortraitDraftContent } from "../server/src/modules/portraits/schema.js";

export const PORTRAIT_FEATURE_FIELDS = [
  "selfTendency",
  "partnerExpectation",
  "hardBoundary",
] as const;

export type PortraitFeatureField = (typeof PORTRAIT_FEATURE_FIELDS)[number];

const nonemptyString = Type.String({ minLength: 1 });
const dimensionSchema = Type.Union([
  Type.Literal("long_term_planning"),
  Type.Literal("values"),
  Type.Literal("relationship_boundaries"),
  Type.Literal("communication"),
  Type.Literal("conflict_repair"),
  Type.Literal("emotional_support"),
  Type.Literal("lifestyle"),
  Type.Literal("family_and_finance"),
]);
const fieldSchema = Type.Union([
  Type.Literal("selfTendency"),
  Type.Literal("partnerExpectation"),
  Type.Literal("hardBoundary"),
]);
const portraitLearningCaseSchema = Type.Object(
  {
    id: nonemptyString,
    category: Type.Union([
      Type.Literal("consistent"),
      Type.Literal("correction"),
      Type.Literal("context_dependent"),
    ]),
    fixedAnswerOptionIds: Type.Array(nonemptyString, {
      minItems: 10,
      maxItems: 10,
    }),
    dialogueMessages: Type.Array(
      Type.Object(
        { id: nonemptyString, content: nonemptyString },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
    gold: Type.Object(
      {
        features: Type.Array(
          Type.Object(
            {
              dimension: dimensionSchema,
              field: fieldSchema,
              concepts: Type.Array(
                Type.Array(nonemptyString, { minItems: 1 }),
                { minItems: 1 },
              ),
              evidenceIds: Type.Array(nonemptyString, { minItems: 1 }),
            },
            { additionalProperties: false },
          ),
          { minItems: 1 },
        ),
        forbiddenClaims: Type.Array(nonemptyString),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const portraitLearningSuiteSchema = Type.Object(
  {
    schemaVersion: Type.Literal("portrait-learning-benchmark-v1"),
    cases: Type.Array(portraitLearningCaseSchema, { minItems: 3 }),
  },
  { additionalProperties: false },
);

export type PortraitLearningCase = Static<typeof portraitLearningCaseSchema>;

const portraitLearningValue: unknown = JSON.parse(
  await readFile(
    new URL("portrait-learning-cases.json", import.meta.url),
    "utf8",
  ),
);
const portraitLearningErrors = [
  ...Value.Errors(portraitLearningSuiteSchema, portraitLearningValue),
];
assert.equal(
  portraitLearningErrors.length,
  0,
  portraitLearningErrors
    .slice(0, 5)
    .map((error) => `${error.instancePath || "/"}: ${error.message}`)
    .join("; "),
);
export const portraitLearningSuite = portraitLearningValue as Static<
  typeof portraitLearningSuiteSchema
>;

export function portraitLearningEvidence(item: PortraitLearningCase) {
  const fixed = FIXED_INTERVIEW_QUESTIONS.map((question, index) => {
    const option = question.options.find(
      (candidate) => candidate.id === item.fixedAnswerOptionIds[index],
    );
    assert(option, `${item.id}: invalid option for ${question.id}`);
    return {
      id: `fixed:${question.id}`,
      content: `固定访谈 ${index + 1}/10：${question.prompt}\n回答：${option.text}`,
      sequence: index + 1,
    };
  });
  return [
    ...fixed,
    ...item.dialogueMessages.map((message, index) => ({
      ...message,
      sequence: fixed.length + index + 1,
    })),
  ];
}

export interface ExpectedPortraitFeature {
  dimension: PortraitDimension;
  field: PortraitFeatureField;
  concepts: string[][];
  evidenceIds: string[];
}

export interface PortraitFeatureGold {
  features: ExpectedPortraitFeature[];
  forbiddenClaims: string[];
}

export interface PortraitFeatureScore {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  precision: number;
  recall: number;
  f1: number;
  slotAccuracy: number;
  missedFeatures: string[];
  unexpectedFeatures: string[];
  vetoes: string[];
}

function ratio(numerator: number, denominator: number, empty = 0) {
  return denominator ? numerator / denominator : empty;
}

function normalized(value: string) {
  return value.replace(/[\s，。！？、,.!?；;：:（）()]/g, "").toLowerCase();
}

function featureKey(dimension: PortraitDimension, field: PortraitFeatureField) {
  return `${dimension}.${field}`;
}

function featureMismatch(
  value: string,
  evidenceIds: readonly string[],
  expected: ExpectedPortraitFeature,
) {
  const content = normalized(value);
  if (
    !expected.concepts.every((alternatives) =>
      alternatives.some((concept) => content.includes(normalized(concept))),
    )
  ) {
    return "concept";
  }
  return expected.evidenceIds.some((id) => evidenceIds.includes(id))
    ? null
    : "evidence";
}

export function scorePortraitFeatures(
  draft: PortraitDraftContent,
  gold: PortraitFeatureGold,
  validEvidenceIds: ReadonlySet<string>,
): PortraitFeatureScore {
  const expectedBySlot = new Map(
    gold.features.map((feature) => [
      featureKey(feature.dimension, feature.field),
      feature,
    ]),
  );
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  const missedFeatures: string[] = [];
  const unexpectedFeatures: string[] = [];
  const vetoes: string[] = [];

  for (const dimension of PORTRAIT_DIMENSIONS) {
    const value = draft[dimension];
    const scored = value.confidence === "medium" || value.confidence === "high";
    for (const id of value.evidenceMessageIds) {
      if (!validEvidenceIds.has(id)) vetoes.push(`unknown_evidence:${id}`);
    }
    if (
      scored &&
      PORTRAIT_FEATURE_FIELDS.some((field) => value[field]?.trim()) &&
      value.evidenceMessageIds.length === 0
    ) {
      vetoes.push(`missing_evidence:${dimension}`);
    }

    for (const field of PORTRAIT_FEATURE_FIELDS) {
      const key = featureKey(dimension, field);
      const expected = expectedBySlot.get(key);
      const prediction = scored ? value[field]?.trim() || null : null;
      if (expected && prediction) {
        const mismatch = featureMismatch(
          prediction,
          value.evidenceMessageIds,
          expected,
        );
        if (!mismatch) {
          truePositive += 1;
        } else {
          falsePositive += 1;
          falseNegative += 1;
          missedFeatures.push(`${key}:${mismatch}`);
          unexpectedFeatures.push(`${key}:${prediction}`);
        }
      } else if (expected) {
        falseNegative += 1;
        missedFeatures.push(key);
      } else if (prediction) {
        falsePositive += 1;
        unexpectedFeatures.push(`${key}:${prediction}`);
      } else {
        trueNegative += 1;
      }
    }
  }

  const serialized = JSON.stringify(draft);
  for (const claim of gold.forbiddenClaims) {
    if (serialized.includes(claim)) vetoes.push(`unsupported_claim:${claim}`);
  }

  const precision = ratio(truePositive, truePositive + falsePositive, 1);
  const recall = ratio(truePositive, truePositive + falseNegative);
  return {
    truePositive,
    falsePositive,
    falseNegative,
    trueNegative,
    precision,
    recall,
    f1: ratio(2 * precision * recall, precision + recall),
    slotAccuracy: ratio(
      truePositive + trueNegative,
      PORTRAIT_DIMENSIONS.length * PORTRAIT_FEATURE_FIELDS.length,
    ),
    missedFeatures,
    unexpectedFeatures,
    vetoes: [...new Set(vetoes)],
  };
}
