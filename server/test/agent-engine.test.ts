import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import {
  AgentEngine,
  AgentRunError,
  type InterviewHistoryMessage,
} from "../src/modules/agent-engine/engine.js";

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
});
