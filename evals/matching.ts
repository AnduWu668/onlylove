import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  PAIR_EVALUATION_SCHEMA_VERSION,
  pairEvaluationResultSchema,
  type PairEvaluationInput,
  type PairEvaluationModelResult,
  type PairEvaluationResult,
  type StructuredMatchCriteria,
} from "../server/src/modules/matching/evaluation.js";
import {
  PORTRAIT_DIMENSIONS,
  type PortraitDimension,
} from "../server/src/modules/portraits/questions.js";
import type {
  PortraitConfidence,
  PortraitDimensionDraft,
  PortraitDraftContent,
} from "../server/src/modules/portraits/schema.js";

export const MATCHING_RUBRIC_VERSION = "matching-rubric-v0";

const nonemptyString = Type.String({ minLength: 1 });
const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const genderSchema = Type.Union([Type.Literal("female"), Type.Literal("male")]);
const modeSchema = Type.Union([
  Type.Literal("preferred"),
  Type.Literal("required"),
  Type.Null(),
]);
const statusSchema = Type.Union([
  Type.Literal("pass"),
  Type.Literal("conflict"),
  Type.Literal("needs_more_information"),
]);
const factsSchema = Type.Object(
  {
    gender: Type.Union([genderSchema, Type.Null()]),
    age: nullableNumber,
    heightCm: nullableNumber,
    city: nullableString,
    occupation: nullableString,
  },
  { additionalProperties: false },
);
const criteriaSchema = Type.Object(
  {
    version: Type.Integer({ minimum: 1 }),
    desiredGender: genderSchema,
    ageMinimum: nullableNumber,
    ageMaximum: nullableNumber,
    ageMode: modeSchema,
    heightMinimumCm: nullableNumber,
    heightMaximumCm: nullableNumber,
    heightMode: modeSchema,
    acceptableCities: Type.Array(Type.String()),
    occupationRequirement: nullableString,
    occupationMode: modeSchema,
  },
  { additionalProperties: false },
);
const dimensionInputSchema = Type.Object(
  {
    selfTendency: Type.Optional(nullableString),
    partnerExpectation: Type.Optional(nullableString),
    hardBoundary: Type.Optional(nullableString),
    importance: Type.Optional(
      Type.Union([
        Type.Integer({ minimum: 1, maximum: 5 }),
        Type.Null(),
      ]),
    ),
    confidence: Type.Optional(
      Type.Union([
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
      ]),
    ),
  },
  { additionalProperties: false },
);
const dimensionsInputSchema = Type.Partial(
  Type.Object(
    Object.fromEntries(
      PORTRAIT_DIMENSIONS.map((dimension) => [dimension, dimensionInputSchema]),
    ),
  ),
);
const memberSchema = Type.Object(
  {
    facts: factsSchema,
    criteria: criteriaSchema,
    dimensions: Type.Optional(dimensionsInputSchema),
  },
  { additionalProperties: false },
);
const memberOverrideSchema = Type.Object(
  {
    facts: Type.Optional(Type.Partial(factsSchema)),
    criteria: Type.Optional(Type.Partial(criteriaSchema)),
    dimensions: Type.Optional(dimensionsInputSchema),
  },
  { additionalProperties: false },
);
const predictionDimensionSchema = Type.Object(
  {
    aToB: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    bToA: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    interactionReason: Type.Optional(nonemptyString),
    hardBoundaryStatus: Type.Optional(statusSchema),
  },
  { additionalProperties: false },
);
const predictionDimensionsSchema = Type.Partial(
  Type.Object(
    Object.fromEntries(
      PORTRAIT_DIMENSIONS.map((dimension) => [
        dimension,
        predictionDimensionSchema,
      ]),
    ),
  ),
);
const predictionSchema = Type.Object(
  {
    defaultAToB: Type.Number({ minimum: 0, maximum: 100 }),
    defaultBToA: Type.Number({ minimum: 0, maximum: 100 }),
    structuredConditionStatus: statusSchema,
    defaultHardBoundaryStatus: statusSchema,
    safeRecommendationReason: nonemptyString,
    dimensions: Type.Optional(predictionDimensionsSchema),
  },
  { additionalProperties: false },
);
const predictionOverrideSchema = Type.Partial(predictionSchema);
const expectedSchema = Type.Object(
  {
    eligibility: Type.Union([
      Type.Literal("eligible"),
      Type.Literal("excluded"),
      Type.Literal("needs_more_information"),
    ]),
    direction: Type.Optional(
      Type.Union([
        Type.Literal("balanced"),
        Type.Literal("a_higher"),
        Type.Literal("b_higher"),
      ]),
    ),
    minimumReciprocal: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    maximumReciprocal: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    rankingGroup: Type.Optional(nonemptyString),
    rank: Type.Optional(Type.Integer({ minimum: 1 })),
    forbiddenReasonTerms: Type.Array(nonemptyString),
  },
  { additionalProperties: false },
);
const matchingSuiteSchema = Type.Object(
  {
    schemaVersion: Type.Literal("matching-benchmark-v0"),
    rubricVersion: Type.Literal(MATCHING_RUBRIC_VERSION),
    defaults: Type.Object(
      {
        memberA: memberSchema,
        memberB: memberSchema,
        prediction: predictionSchema,
      },
      { additionalProperties: false },
    ),
    cases: Type.Array(
      Type.Object(
        {
          id: nonemptyString,
          category: Type.Union([
            Type.Literal("mutual"),
            Type.Literal("one_sided"),
            Type.Literal("structured_boundary"),
            Type.Literal("semantic_boundary"),
            Type.Literal("missing_information"),
            Type.Literal("low_confidence"),
            Type.Literal("similar"),
            Type.Literal("complementary"),
            Type.Literal("complex"),
            Type.Literal("occupation"),
          ]),
          memberA: Type.Optional(memberOverrideSchema),
          memberB: Type.Optional(memberOverrideSchema),
          prediction: Type.Optional(predictionOverrideSchema),
          expected: expectedSchema,
        },
        { additionalProperties: false },
      ),
      { minItems: 20, maxItems: 30 },
    ),
  },
  { additionalProperties: false },
);

const rawSuite: unknown = JSON.parse(
  await readFile(new URL("matching-cases.json", import.meta.url), "utf8"),
);
const suiteErrors = [...Value.Errors(matchingSuiteSchema, rawSuite)];
assert.equal(
  suiteErrors.length,
  0,
  suiteErrors
    .slice(0, 5)
    .map((error) => `${error.instancePath || "/"}: ${error.message}`)
    .join("; "),
);
export const matchingSuite = rawSuite as Static<typeof matchingSuiteSchema>;
export type MatchingCase = (typeof matchingSuite.cases)[number];

export const matchingRubric = await readFile(
  new URL("../agent/matching-rubric.md", import.meta.url),
  "utf8",
);
assert(matchingRubric.includes(`规则版本：\`${MATCHING_RUBRIC_VERSION}\``));
assert(
  matchingRubric.includes(
    `输出 Schema：\`${PAIR_EVALUATION_SCHEMA_VERSION}\``,
  ),
);

function mergedMember(
  base: Static<typeof memberSchema>,
  override: Static<typeof memberOverrideSchema> | undefined,
) {
  return {
    facts: { ...base.facts, ...override?.facts },
    criteria: { ...base.criteria, ...override?.criteria },
    dimensions: { ...base.dimensions, ...override?.dimensions },
  };
}

function dimensionDraft(
  value: Static<typeof dimensionInputSchema> | undefined,
): PortraitDimensionDraft {
  return {
    selfTendency: value?.selfTendency ?? null,
    partnerExpectation: value?.partnerExpectation ?? null,
    hardBoundary: value?.hardBoundary ?? null,
    importance: value?.importance ?? (value ? 3 : null),
    confidence: (value?.confidence ?? (value ? "high" : "low")) as PortraitConfidence,
    evidenceMessageIds: value ? ["synthetic-evidence"] : [],
    contradictions: [],
  };
}

function memberInput(
  base: Static<typeof memberSchema>,
  override: Static<typeof memberOverrideSchema> | undefined,
) {
  const member = mergedMember(base, override);
  return {
    matchProfile: {
      schemaVersion: "match-profile-v1",
      dimensions: Object.fromEntries(
        PORTRAIT_DIMENSIONS.map((dimension) => [
          dimension,
          dimensionDraft(member.dimensions[dimension]),
        ]),
      ) as PortraitDraftContent,
    },
    structuredCriteria: {
      ...member.criteria,
      member: member.facts,
    } as StructuredMatchCriteria,
  };
}

export function matchingInput(item: MatchingCase): PairEvaluationInput {
  return {
    memberA: memberInput(matchingSuite.defaults.memberA, item.memberA),
    memberB: memberInput(matchingSuite.defaults.memberB, item.memberB),
    rubric: { version: matchingSuite.rubricVersion, content: matchingRubric },
  };
}

export function matchingModelOutput(
  item: MatchingCase,
): PairEvaluationModelResult {
  const prediction = {
    ...matchingSuite.defaults.prediction,
    ...item.prediction,
    dimensions: {
      ...matchingSuite.defaults.prediction.dimensions,
      ...item.prediction?.dimensions,
    },
  };
  return {
    schemaVersion: PAIR_EVALUATION_SCHEMA_VERSION,
    rubricVersion: matchingSuite.rubricVersion,
    structuredConditionStatus: prediction.structuredConditionStatus,
    dimensions: PORTRAIT_DIMENSIONS.map((dimension) => {
      const value = prediction.dimensions[dimension];
      return {
        dimension,
        aToB: value?.aToB ?? prediction.defaultAToB,
        bToA: value?.bToA ?? prediction.defaultBToA,
        interactionReason:
          value?.interactionReason ?? "双方在这个方向上仍有可继续了解的空间。",
        hardBoundaryStatus:
          value?.hardBoundaryStatus ?? prediction.defaultHardBoundaryStatus,
      };
    }),
    safeRecommendationReason: prediction.safeRecommendationReason,
  };
}

export function assertMatchingResult(
  item: MatchingCase,
  result: PairEvaluationResult,
) {
  assert(
    Value.Check(pairEvaluationResultSchema, result),
    `${item.id}: invalid result schema`,
  );
  assert.equal(result.eligibility, item.expected.eligibility, `${item.id}: eligibility`);
  assert.equal(new Set(result.dimensions.map((value) => value.dimension)).size, 8);
  const harmonic =
    result.aToBScore + result.bToAScore
      ? Math.round(
          ((2 * result.aToBScore * result.bToAScore) /
            (result.aToBScore + result.bToAScore)) *
            100,
        ) / 100
      : 0;
  assert.equal(result.reciprocalScore, harmonic, `${item.id}: harmonic mean`);
  if (item.expected.direction === "balanced") {
    assert(
      Math.abs(result.aToBScore - result.bToAScore) <= 10,
      `${item.id}: expected balanced directions`,
    );
  } else if (item.expected.direction === "a_higher") {
    assert(result.aToBScore > result.bToAScore, `${item.id}: A→B should be higher`);
  } else if (item.expected.direction === "b_higher") {
    assert(result.bToAScore > result.aToBScore, `${item.id}: B→A should be higher`);
  }
  if (item.expected.minimumReciprocal !== undefined) {
    assert(
      result.reciprocalScore >= item.expected.minimumReciprocal,
      `${item.id}: reciprocal below expected band`,
    );
  }
  if (item.expected.maximumReciprocal !== undefined) {
    assert(
      result.reciprocalScore <= item.expected.maximumReciprocal,
      `${item.id}: reciprocal above expected band`,
    );
  }
  for (const term of item.expected.forbiddenReasonTerms) {
    assert(
      !result.safeRecommendationReason.includes(term),
      `${item.id}: unsafe recommendation reason leaked ${term}`,
    );
  }
}

export function assertMatchingRanking(
  results: { item: MatchingCase; result: PairEvaluationResult }[],
) {
  const groups = new Map<
    string,
    { item: MatchingCase; result: PairEvaluationResult }[]
  >();
  for (const entry of results) {
    const group = entry.item.expected.rankingGroup;
    if (group) groups.set(group, [...(groups.get(group) ?? []), entry]);
  }
  for (const [group, entries] of groups) {
    const ranked = entries.toSorted(
      (left, right) => left.item.expected.rank! - right.item.expected.rank!,
    );
    assert(
      ranked.every((entry) => entry.item.expected.rank !== undefined),
      `${group}: every ranked case needs a rank`,
    );
    for (let index = 1; index < ranked.length; index += 1) {
      assert(
        ranked[index - 1]!.result.reciprocalScore >
          ranked[index]!.result.reciprocalScore,
        `${group}: rank ${ranked[index - 1]!.item.expected.rank} must score above rank ${ranked[index]!.item.expected.rank}`,
      );
    }
  }
}

assert.deepEqual(
  new Set(matchingSuite.cases.map((item) => item.category)),
  new Set([
    "mutual",
    "one_sided",
    "structured_boundary",
    "semantic_boundary",
    "missing_information",
    "low_confidence",
    "similar",
    "complementary",
    "complex",
    "occupation",
  ]),
);
assert.equal(new Set(matchingSuite.cases.map((item) => item.id)).size, matchingSuite.cases.length);
