import { Type, type Static } from "@earendil-works/pi-ai";
import type { Gender, RequirementMode } from "../members/schema.js";
import {
  PORTRAIT_DIMENSIONS,
  type PortraitDimension,
} from "../portraits/questions.js";
import type { MatchProfile } from "../portraits/schema.js";

export const PAIR_EVALUATION_SCHEMA_VERSION = "pair-evaluation-schema-v0";

const nonemptyString = Type.String({ minLength: 1 });
const conditionStatusSchema = Type.Union([
  Type.Literal("pass"),
  Type.Literal("conflict"),
  Type.Literal("needs_more_information"),
]);
export const portraitDimensionSchema = Type.Unsafe<PortraitDimension>(
  Type.Union(PORTRAIT_DIMENSIONS.map((dimension) => Type.Literal(dimension))),
);
const dimensionEvaluationSchema = Type.Object(
  {
    dimension: portraitDimensionSchema,
    aToB: Type.Number({ minimum: 0, maximum: 100 }),
    bToA: Type.Number({ minimum: 0, maximum: 100 }),
    interactionReason: nonemptyString,
    hardBoundaryStatus: conditionStatusSchema,
  },
  { additionalProperties: false },
);
const modelResultProperties = {
  schemaVersion: Type.Literal(PAIR_EVALUATION_SCHEMA_VERSION),
  rubricVersion: nonemptyString,
  structuredConditionStatus: conditionStatusSchema,
  dimensions: Type.Array(dimensionEvaluationSchema, {
    minItems: PORTRAIT_DIMENSIONS.length,
    maxItems: PORTRAIT_DIMENSIONS.length,
  }),
  safeRecommendationReason: nonemptyString,
};

export const modelPairEvaluationSchema = Type.Object(modelResultProperties, {
  additionalProperties: false,
});
export const pairEvaluationResultSchema = Type.Object(
  {
    ...modelResultProperties,
    aToBScore: Type.Number({ minimum: 0, maximum: 100 }),
    bToAScore: Type.Number({ minimum: 0, maximum: 100 }),
    reciprocalScore: Type.Number({ minimum: 0, maximum: 100 }),
    eligibility: Type.Union([
      Type.Literal("eligible"),
      Type.Literal("excluded"),
      Type.Literal("needs_more_information"),
    ]),
  },
  { additionalProperties: false },
);

export type PairEvaluationModelResult = Static<
  typeof modelPairEvaluationSchema
>;
export type PairEvaluationResult = Static<typeof pairEvaluationResultSchema>;
export type PairConditionStatus = Static<typeof conditionStatusSchema>;

export interface StructuredMatchCriteria {
  version: number;
  member: {
    gender: Gender | null;
    age: number | null;
    heightCm: number | null;
    city: string | null;
    occupation: string | null;
  };
  desiredGender: Gender;
  ageMinimum: number | null;
  ageMaximum: number | null;
  ageMode: RequirementMode | null;
  heightMinimumCm: number | null;
  heightMaximumCm: number | null;
  heightMode: RequirementMode | null;
  acceptableCities: string[];
  occupationRequirement: string | null;
  occupationMode: RequirementMode | null;
}

export interface PairMemberEvaluationInput {
  matchProfile: MatchProfile;
  structuredCriteria: StructuredMatchCriteria;
}

export interface PairEvaluationInput {
  memberA: PairMemberEvaluationInput;
  memberB: PairMemberEvaluationInput;
  rubric: { version: string; content: string };
}

function scoredDimensions(profile: MatchProfile) {
  return Object.fromEntries(
    PORTRAIT_DIMENSIONS.map((dimension) => {
      const value = profile.dimensions[dimension];
      return [
        dimension,
        value.confidence === "low"
          ? {
              selfTendency: null,
              partnerExpectation: null,
              hardBoundary: null,
              importance: null,
              confidence: "low",
            }
          : {
              selfTendency: value.selfTendency,
              partnerExpectation: value.partnerExpectation,
              hardBoundary: value.hardBoundary,
              importance: value.importance,
              confidence: value.confidence,
            },
      ];
    }),
  );
}

export function pairEvaluationPrompt(input: PairEvaluationInput) {
  const pair = {
    memberA: {
      matchProfile: {
        schemaVersion: input.memberA.matchProfile.schemaVersion,
        dimensions: scoredDimensions(input.memberA.matchProfile),
      },
      structuredCriteria: input.memberA.structuredCriteria,
    },
    memberB: {
      matchProfile: {
        schemaVersion: input.memberB.matchProfile.schemaVersion,
        dimensions: scoredDimensions(input.memberB.matchProfile),
      },
      structuredCriteria: input.memberB.structuredCriteria,
    },
  };
  return [
    `匹配评判规则版本：${input.rubric.version}`,
    input.rubric.content,
    `待评估配对：${JSON.stringify(pair)}`,
    `输出 Schema：${JSON.stringify(modelPairEvaluationSchema)}`,
  ].join("\n\n");
}

function combineStatus(...statuses: PairConditionStatus[]) {
  if (statuses.includes("conflict")) return "conflict";
  if (statuses.includes("needs_more_information")) {
    return "needs_more_information";
  }
  return "pass";
}

function requiredRangeStatus(
  value: number | null,
  minimum: number | null,
  maximum: number | null,
  mode: RequirementMode | null,
): PairConditionStatus {
  if (mode !== "required" || (minimum === null && maximum === null)) {
    return "pass";
  }
  if (value === null) return "needs_more_information";
  return (minimum === null || value >= minimum) &&
    (maximum === null || value <= maximum)
    ? "pass"
    : "conflict";
}

function directionalDeterministicStatus(
  criteria: StructuredMatchCriteria,
  candidate: StructuredMatchCriteria["member"],
): PairConditionStatus {
  if (candidate.gender === null) return "needs_more_information";
  if (candidate.gender !== criteria.desiredGender) return "conflict";
  const age = requiredRangeStatus(
    candidate.age,
    criteria.ageMinimum,
    criteria.ageMaximum,
    criteria.ageMode,
  );
  const height = requiredRangeStatus(
    candidate.heightCm,
    criteria.heightMinimumCm,
    criteria.heightMaximumCm,
    criteria.heightMode,
  );
  const city = !criteria.acceptableCities.length
    ? "pass"
    : candidate.city === null
      ? "needs_more_information"
      : criteria.acceptableCities.includes(candidate.city)
        ? "pass"
        : "conflict";
  return combineStatus(age, height, city);
}

function directionalStructuredStatus(
  criteria: StructuredMatchCriteria,
  candidate: StructuredMatchCriteria["member"],
): PairConditionStatus {
  const occupation =
    criteria.occupationMode === "required" &&
    criteria.occupationRequirement &&
    !candidate.occupation
      ? "needs_more_information"
      : "pass";
  return combineStatus(
    directionalDeterministicStatus(criteria, candidate),
    occupation,
  );
}

export function deterministicPairStatus(input: PairEvaluationInput) {
  return combineStatus(
    directionalDeterministicStatus(
      input.memberA.structuredCriteria,
      input.memberB.structuredCriteria.member,
    ),
    directionalDeterministicStatus(
      input.memberB.structuredCriteria,
      input.memberA.structuredCriteria.member,
    ),
  );
}

function deterministicStructuredStatus(input: PairEvaluationInput) {
  return combineStatus(
    directionalStructuredStatus(
      input.memberA.structuredCriteria,
      input.memberB.structuredCriteria.member,
    ),
    directionalStructuredStatus(
      input.memberB.structuredCriteria,
      input.memberA.structuredCriteria.member,
    ),
  );
}

function weight(
  memberProfile: MatchProfile,
  candidateProfile: MatchProfile,
  dimension: PortraitDimension,
) {
  const member = memberProfile.dimensions[dimension];
  const candidate = candidateProfile.dimensions[dimension];
  return member.confidence === "low" || candidate.confidence === "low"
    ? 0
    : (member.importance ?? 1);
}

function rounded(value: number) {
  return Math.round(value * 100) / 100;
}

function weightedScore(
  memberProfile: MatchProfile,
  candidateProfile: MatchProfile,
  dimensions: PairEvaluationModelResult["dimensions"],
  direction: "aToB" | "bToA",
) {
  const weights = dimensions.map((item) =>
    weight(memberProfile, candidateProfile, item.dimension),
  );
  const totalWeight = weights.reduce((total, value) => total + value, 0);
  if (!totalWeight) return 0;
  return rounded(
    dimensions.reduce(
      (total, item, index) => total + item[direction] * weights[index]!,
      0,
    ) / totalWeight,
  );
}

function normalizedStructuredStatus(
  input: PairEvaluationInput,
  modelStatus: PairConditionStatus,
) {
  const deterministic = deterministicStructuredStatus(input);
  if (deterministic !== "pass") return deterministic;
  const hasRequiredOccupation = [input.memberA, input.memberB].some(
    ({ structuredCriteria }) =>
      structuredCriteria.occupationMode === "required" &&
      Boolean(structuredCriteria.occupationRequirement),
  );
  return hasRequiredOccupation ? modelStatus : "pass";
}

function normalizedBoundaryStatus(
  input: PairEvaluationInput,
  dimension: PortraitDimension,
  modelStatus: PairConditionStatus,
): PairConditionStatus {
  const a = input.memberA.matchProfile.dimensions[dimension];
  const b = input.memberB.matchProfile.dimensions[dimension];
  const aBoundary = a.confidence === "high" && Boolean(a.hardBoundary?.trim());
  const bBoundary = b.confidence === "high" && Boolean(b.hardBoundary?.trim());
  if (!aBoundary && !bBoundary) return "pass";
  const aHasInformation =
    !aBoundary ||
    (b.confidence !== "low" && Boolean(b.selfTendency?.trim()));
  const bHasInformation =
    !bBoundary ||
    (a.confidence !== "low" && Boolean(a.selfTendency?.trim()));
  const hasInformedBoundary =
    (aBoundary && aHasInformation) || (bBoundary && bHasInformation);
  if (modelStatus === "conflict" && hasInformedBoundary) return "conflict";
  if (!aHasInformation || !bHasInformation) return "needs_more_information";
  return modelStatus;
}

function safeRecommendationReason(
  input: PairEvaluationInput,
  eligibility: PairEvaluationResult["eligibility"],
  proposed: string,
) {
  if (eligibility === "excluded") {
    return "当前条件不支持形成候选推荐。";
  }
  if (eligibility === "needs_more_information") {
    return "目前还需要补充信息，暂不形成候选推荐。";
  }
  const hiddenSourceTerms = [input.memberA, input.memberB].flatMap((member) => [
    member.structuredCriteria.occupationRequirement,
    ...Object.values(member.matchProfile.dimensions).flatMap((dimension) => [
      dimension.hardBoundary,
      ...(dimension.confidence === "low"
        ? [dimension.selfTendency, dimension.partnerExpectation]
        : []),
    ]),
  ]);
  const reason = proposed.trim();
  if (
    reason &&
    !/selfTendency|partnerExpectation|hardBoundary|evidenceMessageIds|画像|置信度|隐藏标签|内部理由|互惠适合度|适合度|得分|分数|百分之|\d+(?:\.\d+)?\s*(?:%|％|分)/i.test(
      reason,
    ) &&
    !hiddenSourceTerms.some(
      (term) => term?.trim() && reason.includes(term.trim()),
    )
  ) {
    return reason;
  }
  return "你们可以通过进一步交流，确认彼此在重要关系议题上的期待。";
}

export function finalizePairEvaluation(
  input: PairEvaluationInput,
  modelResult: PairEvaluationModelResult,
): PairEvaluationResult {
  if (modelResult.rubricVersion !== input.rubric.version) {
    throw new Error("匹配评判规则版本不一致");
  }
  const byDimension = new Map(
    modelResult.dimensions.map((item) => [item.dimension, item]),
  );
  if (
    byDimension.size !== PORTRAIT_DIMENSIONS.length ||
    PORTRAIT_DIMENSIONS.some((dimension) => !byDimension.has(dimension))
  ) {
    throw new Error("配对评估必须恰好覆盖八个关系维度");
  }
  const dimensions = PORTRAIT_DIMENSIONS.map((dimension) => ({
    ...byDimension.get(dimension)!,
    hardBoundaryStatus: normalizedBoundaryStatus(
      input,
      dimension,
      byDimension.get(dimension)!.hardBoundaryStatus,
    ),
  }));
  const structuredConditionStatus = normalizedStructuredStatus(
    input,
    modelResult.structuredConditionStatus,
  );
  const boundaryStatus = combineStatus(
    structuredConditionStatus,
    ...dimensions.map((item) => item.hardBoundaryStatus),
  );
  const aToBScore = weightedScore(
    input.memberA.matchProfile,
    input.memberB.matchProfile,
    dimensions,
    "aToB",
  );
  const bToAScore = weightedScore(
    input.memberB.matchProfile,
    input.memberA.matchProfile,
    dimensions,
    "bToA",
  );
  const eligibility =
    boundaryStatus === "conflict"
      ? "excluded"
      : boundaryStatus === "needs_more_information"
        ? "needs_more_information"
        : "eligible";
  return {
    ...modelResult,
    structuredConditionStatus,
    dimensions,
    aToBScore,
    bToAScore,
    reciprocalScore:
      aToBScore + bToAScore
        ? rounded((2 * aToBScore * bToAScore) / (aToBScore + bToAScore))
        : 0,
    eligibility,
    safeRecommendationReason: safeRecommendationReason(
      input,
      eligibility,
      modelResult.safeRecommendationReason,
    ),
  };
}
