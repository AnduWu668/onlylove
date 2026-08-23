import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import {
  AgentEngine,
  AgentRunError,
  type InterviewHistoryMessage,
} from "../src/modules/agent-engine/engine.js";
import { PORTRAIT_DIMENSIONS } from "../src/modules/portraits/questions.js";

function interviewContext(recentMessages: InterviewHistoryMessage[] = []) {
  return {
    memberProfile: {
      nickname: "测试成员",
      birthDate: "1990-01-01",
      gender: "female",
      heightCm: 165,
      city: "上海",
      occupation: "设计师",
    },
    matchCriteria: null,
    recentMessages,
  };
}

describe("Agent Engine continueInterview seam", () => {
  it("explicitly disables Ark deep thinking", async () => {
    let requestBody: unknown;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({
            id: "test-response",
            model: "ark-test-v1",
            choices: [
              { index: 0, delta: { content: "请继续说说。" }, finish_reason: null },
            ],
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            id: "test-response",
            model: "ark-test-v1",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server unavailable");
    }
    const engine = new AgentEngine({
      provider: "volcengine-ark",
      apiKey: "test-only-key",
      model: "ark-test-v1",
      baseUrl: `http://127.0.0.1:${address.port}`,
      pricing: {
        effectiveDate: "2026-08-20",
        inputCostCnyPerMillionTokens: 0,
        outputCostCnyPerMillionTokens: 0,
      },
    });

    try {
      await engine.continueInterview(
        interviewContext(),
        "继续",
        () => undefined,
        async () => undefined,
      );
      expect(requestBody).toMatchObject({ thinking: { type: "disabled" } });
    } finally {
      engine.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("retries before output and switches the whole request to the backup model", async () => {
    const engine = new AgentEngine({
      provider: "deterministic-fake",
      model: "primary-v1",
      backupModel: "backup-v1",
      attempts: [
        { model: "primary-v1", error: "primary unavailable" },
        { model: "primary-v1", error: "primary unavailable" },
        { model: "backup-v1", reply: "备用模型给出了完整回答。" },
      ],
    });
    const chunks: string[] = [];

    const result = await engine.continueInterview(
      interviewContext(),
      "我想聊聊关系中的边界。",
      (chunk) => chunks.push(chunk),
      async () => undefined,
    );

    expect(chunks.join("")).toBe("备用模型给出了完整回答。");
    expect(result.actualModel).toBe("backup-v1");
    expect(result.attempts).toMatchObject([
      {
        requestedModel: "primary-v1",
        error: "MODEL_REQUEST_FAILED: primary unavailable",
      },
      {
        requestedModel: "primary-v1",
        error: "MODEL_REQUEST_FAILED: primary unavailable",
      },
      { requestedModel: "backup-v1", error: null },
    ]);
    expect(result.retryCount).toBe(2);
    expect(result.switchedModel).toBe(true);
    engine.close();
  });

  it("never joins a backup response after streaming has started", async () => {
    const engine = new AgentEngine({
      provider: "deterministic-fake",
      model: "primary-v1",
      backupModel: "backup-v1",
      attempts: [
        {
          model: "primary-v1",
          partialText: "已经发出的半句话",
          error: "connection closed",
        },
        { model: "backup-v1", reply: "不应拼接的回答" },
      ],
    });
    const chunks: string[] = [];

    const failure = await engine
      .continueInterview(
        interviewContext(),
        "继续",
        (chunk) => chunks.push(chunk),
        async () => undefined,
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AgentRunError);
    expect(chunks.join("")).toBe("已经发出的半句话");
    expect((failure as AgentRunError).attempts).toHaveLength(1);
    expect((failure as AgentRunError).switchedModel).toBe(false);
    engine.close();
  });

  it("reports three exhausted attempts so the job enters the error list", async () => {
    const engine = new AgentEngine({
      provider: "deterministic-fake",
      model: "primary-v1",
      attempts: [
        { error: "first failure" },
        { error: "second failure" },
        { error: "third failure" },
      ],
    });

    const failure = await engine
      .continueInterview(
        interviewContext(),
        "继续",
        () => undefined,
        async () => undefined,
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AgentRunError);
    expect((failure as AgentRunError).attempts).toHaveLength(3);
    expect((failure as AgentRunError).retryCount).toBe(3);
    engine.close();
  });

  it("retries an unpersisted twin prediction after a partial model failure", async () => {
    const engine = new AgentEngine({
      provider: "deterministic-fake",
      model: "primary-v1",
      attempts: [
        { partialText: "未保存的半句话", error: "connection closed" },
        { reply: "重新生成的完整预测。" },
      ],
    });

    const result = await engine.replyAsTwin(
      {
        personaContext: "# 恋爱分身上下文\n会先沟通再决定。",
        publicProfile: null,
        recentMessages: [],
      },
      "伴侣想去外地工作，你会怎样回应？",
      undefined,
      async () => undefined,
    );

    expect(result.text).toBe("重新生成的完整预测。");
    expect(result.attempts).toHaveLength(2);
    engine.close();
  });

  it("repairs invalid structured output once with the same model", async () => {
    const engine = new AgentEngine({
      provider: "deterministic-fake",
      model: "extractor-v1",
      attempts: [
        { reply: JSON.stringify({ summary: 7 }) },
        {
          reply: JSON.stringify({ summary: "更在意冲突后的修复方式。" }),
          promptIncludes: ['"summary"', "/summary"],
        },
      ],
    });

    let recordedAttempts = 0;
    const result = await engine.extractPortrait(
      "从本次访谈提取画像草稿。",
      Type.Object({ summary: Type.String() }),
      async (attempts) => {
        recordedAttempts = attempts.length;
      },
    );

    expect(result.value).toEqual({ summary: "更在意冲突后的修复方式。" });
    expect(result.attempts).toHaveLength(2);
    expect(recordedAttempts).toBe(2);
    expect(result.attempts.map((attempt) => attempt.requestedModel)).toEqual([
      "extractor-v1",
      "extractor-v1",
    ]);
    engine.close();
  });

  it("fails structured output after the single repair is still invalid", async () => {
    const engine = new AgentEngine({
      provider: "deterministic-fake",
      model: "extractor-v1",
      attempts: [
        { reply: JSON.stringify({ summary: 7 }) },
        { reply: JSON.stringify({ summary: false }) },
        { reply: JSON.stringify({ summary: "第三次不应被调用" }) },
      ],
    });

    const failure = await engine
      .extractPortrait(
        "从本次访谈提取画像草稿。",
        Type.Object({ summary: Type.String() }),
        async () => undefined,
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AgentRunError);
    expect((failure as AgentRunError).code).toBe("STRUCTURED_OUTPUT_INVALID");
    expect((failure as AgentRunError).attempts).toHaveLength(2);
    engine.close();
  });

  it("lets the deterministic extractor derive a reply from the current prompt", async () => {
    const engine = new AgentEngine({
      provider: "deterministic-fake",
      model: "extractor-v1",
      reply: "unused text reply",
      extractReply: (prompt) =>
        JSON.stringify({ summary: prompt.includes("evidence-17") ? "found" : "missing" }),
    });

    const result = await engine.extractPortrait(
      "extract evidence-17",
      Type.Object({ summary: Type.String() }),
      async () => undefined,
    );

    expect(result.value).toEqual({ summary: "found" });
    engine.close();
  });

  it("assembles member data and recent messages within the token budget", async () => {
    const history = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 ? ("agent" as const) : ("member" as const),
      content: `${index}:` + "界".repeat(998),
    }));
    const engine = new AgentEngine(
      {
        provider: "deterministic-fake",
        model: "context-v1",
        attempts: [
          {
            reply: "已读取最小上下文。",
            historyMessageCount: 1,
            systemPromptIncludes: ["测试成员"],
          },
        ],
      },
      1_500,
    );

    const result = await engine.continueInterview(
      interviewContext(history),
      "继续",
      () => undefined,
      async () => undefined,
    );

    expect(result.text).toBe("已读取最小上下文。");
    engine.close();
  });

  it("answers an unseen scenario from only the published twin context", async () => {
    const engine = new AgentEngine({
      provider: "deterministic-fake",
      model: "twin-v1",
      attempts: [
        {
          reply: "我会先确认两个人各自不能放弃的部分，再讨论可逆的尝试。",
          promptIncludes: ["伴侣收到外地工作机会"],
          systemPromptIncludes: ["长期计划需要共同决定"],
        },
      ],
    });

    let recorded = 0;
    const result = await engine.replyAsTwin(
      {
        personaContext: "长期计划需要共同决定",
        publicProfile: null,
        recentMessages: [],
      },
      "伴侣收到外地工作机会，你会怎样一起决定？",
      undefined,
      async (attempts) => {
        recorded = attempts.length;
      },
    );

    expect(result.text).toContain("可逆的尝试");
    expect(recorded).toBe(1);
    expect(engine.twinDefinition).toMatchObject({
      role: "public_twin",
      task: "reply_as_twin",
      version: "public-twin-v2",
    });
    engine.close();
  });

  it("answers a self-twin message from only its pinned public context and history", async () => {
    const engine = new AgentEngine({
      provider: "deterministic-fake",
      model: "self-twin-v1",
      attempts: [
        {
          reply: "我是 AI 恋爱分身。我会先说明需要独处，再约定重新沟通的时间。",
          promptIncludes: ["如果这次争执很激烈呢？"],
          historyMessageCount: 2,
          systemPromptIncludes: [
            "冲突后需要独处半小时",
            "林夏",
            "上海",
          ],
        },
      ],
    });
    const chunks: string[] = [];

    const result = await engine.replyAsTwin(
      {
        personaContext: "冲突后需要独处半小时",
        publicProfile: {
          nickname: "林夏",
          birthDate: "1990-04-12",
          gender: "female",
          heightCm: 165,
          city: "上海",
          occupation: "产品设计师",
        },
        recentMessages: [
          { role: "member", content: "发生分歧时你会怎么做？" },
          { role: "agent", content: "我通常会先冷静一下。" },
        ],
      },
      "如果这次争执很激烈呢？",
      (chunk) => chunks.push(chunk),
      async () => undefined,
    );

    expect(chunks.join("")).toBe(result.text);
    expect(result.text).toContain("AI 恋爱分身");
    engine.close();
  });
});

describe("Agent Engine evaluatePair seam", () => {
  it("weights both directions and derives reciprocal suitability", async () => {
    const profile = (importance: number) => ({
      schemaVersion: "match-profile-v1",
      dimensions: Object.fromEntries(
        PORTRAIT_DIMENSIONS.map((dimension) => [
          dimension,
          {
            selfTendency: "愿意协商",
            partnerExpectation: "愿意协商",
            hardBoundary: null,
            importance,
            confidence: "high",
            evidenceMessageIds: ["hidden-evidence-id"],
            contradictions: [],
          },
        ]),
      ),
    });
    const criteria = (gender: "female" | "male") => ({
      version: 1,
      member: {
        gender,
        age: 30,
        heightCm: 170,
        city: "上海",
        occupation: "设计师",
      },
      desiredGender: gender === "female" ? "male" : "female",
      ageMinimum: null,
      ageMaximum: null,
      ageMode: null,
      heightMinimumCm: null,
      heightMaximumCm: null,
      heightMode: null,
      acceptableCities: [],
      occupationRequirement: null,
      occupationMode: null,
    });
    const modelOutput = {
      schemaVersion: "pair-evaluation-schema-v0",
      rubricVersion: "matching-rubric-v0",
      structuredConditionStatus: "pass",
      dimensions: PORTRAIT_DIMENSIONS.map((dimension) => ({
        dimension,
        aToB: 80,
        bToA: 20,
        interactionReason: "两人的协商节奏需要进一步磨合。",
        hardBoundaryStatus: "pass",
      })),
      safeRecommendationReason: "你们匹配八十分，可以进一步了解彼此。",
    };
    const engine = new AgentEngine({
      provider: "deterministic-fake",
      model: "matching-v0",
      attempts: [
        {
          reply: JSON.stringify(modelOutput),
          promptIncludes: ["匹配评判规则版本", "测试规则", "structuredCriteria"],
          promptExcludes: ["hidden-evidence-id", "recentMessages", "personaContext"],
        },
      ],
    });

    const result = await engine.evaluatePair(
      {
        memberA: { matchProfile: profile(5), structuredCriteria: criteria("female") },
        memberB: { matchProfile: profile(1), structuredCriteria: criteria("male") },
        rubric: { version: "matching-rubric-v0", content: "测试规则" },
      },
      async () => undefined,
    );

    expect(result.value).toMatchObject({
      aToBScore: 80,
      bToAScore: 20,
      reciprocalScore: 32,
      eligibility: "eligible",
      safeRecommendationReason:
        "你们可以通过进一步交流，确认彼此在重要关系议题上的期待。",
    });
    expect(result.attempts).toHaveLength(1);
    engine.close();
  });
});
