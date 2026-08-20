import { describe, expect, it } from "vitest";
import { AgentEngine } from "../src/modules/agent-engine/engine.js";

describe.skipIf(process.env.RUN_ARK_INTEGRATION !== "1")(
  "explicit Ark integration",
  () => {
    it("streams a reply through the production Pi runtime", async () => {
      const apiKey = process.env.ARK_API_KEY;
      const model = process.env.ARK_MODEL_ID;
      if (!apiKey || !model) {
        throw new Error("ARK_API_KEY and ARK_MODEL_ID are required");
      }
      const engine = new AgentEngine({
        provider: "volcengine-ark",
        apiKey,
        model,
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        pricing: {
          effectiveDate: "1970-01-01",
          inputCostCnyPerMillionTokens: 0,
          outputCostCnyPerMillionTokens: 0,
        },
      });
      const chunks: string[] = [];

      const result = await engine.continueInterview(
        {
          memberProfile: {
            nickname: "",
            birthDate: "",
            gender: "",
            heightCm: null,
            city: "",
            occupation: "",
          },
          matchCriteria: null,
          recentMessages: [],
        },
        "请用一句简短问题询问我在关系冲突后如何重新沟通。",
        (chunk) => chunks.push(chunk),
        async () => undefined,
      );

      expect(chunks.join("").trim()).not.toBe("");
      expect(result.provider).toBe("volcengine-ark");
      expect(result.actualModel).not.toBe("");
      expect(result.inputTokens).toBeGreaterThan(0);
      engine.close();
    }, 60_000);
  },
);
