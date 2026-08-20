import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { and, asc, count, eq, gt, lte, max, sql } from "drizzle-orm";
import type { Database } from "../../db.js";
import {
  AgentEngine,
  AgentRunError,
  type AgentAttemptResult,
} from "../agent-engine/engine.js";
import {
  conversationMessages,
  conversations,
} from "../conversations/schema.js";
import {
  FIXED_INTERVIEW_QUESTIONS,
  PORTRAIT_DIMENSIONS,
  publicQuestion,
  type PortraitDimension,
} from "./questions.js";
import {
  portraitDrafts,
  portraitFixedAnswers,
  type PortraitDimensionDraft,
  type PortraitDraftContent,
} from "./schema.js";

export const PORTRAIT_SCHEMA_VERSION = "portrait-draft-schema-v1";
export const QUESTION_PLANNER_VERSION = "portrait-question-planner-v1";

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

function completedDimensions(content: PortraitDraftContent) {
  return PORTRAIT_DIMENSIONS.filter((dimension) =>
    ["medium", "high"].includes(content[dimension].confidence),
  ).length;
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

export class Portraits {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date,
  ) {}

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

  async submitFixedAnswer(memberId: string, input: FixedAnswerInput) {
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

    await this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${memberId}))`,
      );
      const existing = (
        await transaction
          .select({ questionId: portraitFixedAnswers.questionId })
          .from(portraitFixedAnswers)
          .where(
            and(
              eq(portraitFixedAnswers.memberId, memberId),
              eq(portraitFixedAnswers.questionId, input.questionId),
            ),
          )
          .limit(1)
      )[0];
      if (existing) return;

      const answers = await transaction
        .select({ questionId: portraitFixedAnswers.questionId })
        .from(portraitFixedAnswers)
        .where(eq(portraitFixedAnswers.memberId, memberId))
        .orderBy(asc(portraitFixedAnswers.createdAt));
      if (FIXED_INTERVIEW_QUESTIONS[answers.length]?.id !== input.questionId) {
        throw new PortraitInputError("FIXED_QUESTION_OUT_OF_ORDER");
      }

      const savedAt = this.now();
      await transaction
        .insert(conversations)
        .values({
          id: randomUUID(),
          type: "INTERVIEW",
          memberId,
          createdAt: savedAt,
        })
        .onConflictDoNothing();
      const conversation = (
        await transaction
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.memberId, memberId),
              eq(conversations.type, "INTERVIEW"),
            ),
          )
          .limit(1)
      )[0]!;
      const lastSequence = (
        await transaction
          .select({ value: max(conversationMessages.sequence) })
          .from(conversationMessages)
          .where(eq(conversationMessages.conversationId, conversation.id))
      )[0]?.value;
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
      const message = (
        await transaction
          .insert(conversationMessages)
          .values({
            id: randomUUID(),
            conversationId: conversation.id,
            role: "member",
            content,
            sequence: (lastSequence ?? 0) + 1,
            createdAt: savedAt,
          })
          .returning({ id: conversationMessages.id })
      )[0]!;
      await transaction.insert(portraitFixedAnswers).values({
        memberId,
        questionId: input.questionId,
        selectedOptionIds: selected,
        noneApplies: input.noneApplies,
        freeText,
        messageId: message.id,
        createdAt: savedAt,
      });
    });

    return this.interviewState(memberId);
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
    const correction = /不像我|不是我|理解错|不准确|纠正/.test(latestMessage);
    const lowConfidence = PORTRAIT_DIMENSIONS.find(
      (dimension) => content[dimension].confidence === "low",
    );
    const contradiction = PORTRAIT_DIMENSIONS.find(
      (dimension) => content[dimension].contradictions.length > 0,
    );
    return {
      portraitDraft: content,
      questionPlannerVersion: QUESTION_PLANNER_VERSION,
      planningPriority: correction
        ? "member_correction"
        : lowConfidence
          ? `low_confidence:${lowConfidence}`
          : contradiction
            ? `contradiction:${contradiction}`
            : "published_common_weakness:preference_vs_boundary",
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
      this.db
        .select({
          id: conversationMessages.id,
          content: conversationMessages.content,
          sequence: conversationMessages.sequence,
        })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.conversationId, conversationId),
            eq(conversationMessages.role, "member"),
            lte(conversationMessages.sequence, throughSequence),
          ),
        )
        .orderBy(asc(conversationMessages.sequence)),
    ]);
    const current = savedDraft[0];
    const newEvidence = messages.filter(
      (message) => message.sequence > (current?.lastMessageSequence ?? 0),
    );
    if (!newEvidence.length) {
      return {
        previousCompleted: current?.completedDimensions ?? 0,
        completed: current?.completedDimensions ?? 0,
      };
    }

    const prompt = JSON.stringify({
      instruction:
        "只依据 evidenceMessages 更新完整八维画像草稿。没有证据时保持原值或低置信度；矛盾写入 contradictions；每个结论只引用实际支持它的消息 id。",
      schemaVersion: PORTRAIT_SCHEMA_VERSION,
      currentDraft: current?.content ?? emptyPortraitDraft(),
      evidenceMessages: newEvidence,
    });
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
      for (const dimension of PORTRAIT_DIMENSIONS) {
        const value = content[dimension];
        if (
          value.evidenceMessageIds.some((id) => !validEvidence.has(id)) ||
          (["medium", "high"].includes(value.confidence) &&
            value.evidenceMessageIds.length === 0)
        ) {
          attempts.at(-1)!.error = "PORTRAIT_EVIDENCE_INVALID";
          throw new AgentRunError("PORTRAIT_EVIDENCE_INVALID", attempts);
        }
      }
      await recordAttempts(attempts);
      const completed = completedDimensions(content);
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
        previousCompleted: current?.completedDimensions ?? 0,
        completed,
      };
    } catch (error) {
      if (error instanceof AgentRunError) attempts = error.attempts;
      await recordAttempts(attempts);
      throw error;
    }
  }
}
