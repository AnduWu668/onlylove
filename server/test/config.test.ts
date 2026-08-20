import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";

describe("production configuration", () => {
  it("rejects the public OTP secret placeholder", () => {
    expect(() =>
      readConfig({
        NODE_ENV: "production",
        OTP_SECRET: "replace-with-a-long-random-value",
        SUPER_ADMIN_EMAIL: "admin@example.com",
      }),
    ).toThrow("OTP_SECRET");
  });

  it("rejects partial or non-Beijing Ark configuration", () => {
    expect(() =>
      readConfig({
        ARK_API_KEY: "secret",
        SUPER_ADMIN_EMAIL: "admin@example.com",
      }),
    ).toThrow("ARK_MODEL_ID");
    expect(() =>
      readConfig({
        ARK_API_KEY: "secret",
        ARK_MODEL_ID: "doubao-fixed-260101",
        ARK_INPUT_COST_CNY_PER_MILLION_TOKENS: "1",
        ARK_OUTPUT_COST_CNY_PER_MILLION_TOKENS: "2",
        ARK_PRICING_EFFECTIVE_DATE: "2026-08-01",
        ARK_BASE_URL: "https://example.com/api/v3",
        SUPER_ADMIN_EMAIL: "admin@example.com",
      }),
    ).toThrow("ARK_BASE_URL");
  });

  it("builds a fixed Ark model configuration with effective-dated pricing", () => {
    const config = readConfig({
      ARK_API_KEY: "secret",
      ARK_MODEL_ID: "doubao-fixed-260101",
      ARK_BACKUP_MODEL_ID: "doubao-backup-260101",
      ARK_INPUT_COST_CNY_PER_MILLION_TOKENS: "1.2",
      ARK_OUTPUT_COST_CNY_PER_MILLION_TOKENS: "3.4",
      ARK_PRICING_EFFECTIVE_DATE: "2026-08-01",
      SUPER_ADMIN_EMAIL: "admin@example.com",
    });

    expect(config.agentModel).toMatchObject({
      provider: "volcengine-ark",
      model: "doubao-fixed-260101",
      backupModel: "doubao-backup-260101",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      pricing: {
        inputCostCnyPerMillionTokens: 1.2,
        outputCostCnyPerMillionTokens: 3.4,
        effectiveDate: "2026-08-01",
      },
    });
  });

  it("requires a complete effective-dated pricing snapshot", () => {
    expect(() =>
      readConfig({
        ARK_API_KEY: "secret",
        ARK_MODEL_ID: "doubao-fixed-260101",
        SUPER_ADMIN_EMAIL: "admin@example.com",
      }),
    ).toThrow("ARK_INPUT_COST_CNY_PER_MILLION_TOKENS");
  });

  it("uses a configurable 32K default Agent input budget", () => {
    expect(readConfig({ SUPER_ADMIN_EMAIL: "admin@example.com" })).toMatchObject({
      agentInputTokenBudget: 32_768,
    });
    expect(
      readConfig({
        AGENT_INPUT_TOKEN_BUDGET: "16384",
        SUPER_ADMIN_EMAIL: "admin@example.com",
      }).agentInputTokenBudget,
    ).toBe(16_384);
  });
});
