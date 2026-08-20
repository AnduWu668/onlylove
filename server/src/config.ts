import type { ArkAgentModelOptions } from "./modules/agent-engine/engine.js";

export interface ServerConfig {
  agentInputTokenBudget: number;
  agentModel?: ArkAgentModelOptions;
  databaseUrl: string;
  otpSecret: string;
  port: number;
  production: boolean;
  superAdminEmail: string;
}

export function readConfig(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  const production = env.NODE_ENV === "production";
  const databaseUrl =
    env.DATABASE_URL ?? "postgres://onlylove:onlylove@localhost:5433/onlylove";
  const superAdminEmail =
    env.SUPER_ADMIN_EMAIL ?? (production ? "" : "admin@onlylove.local");
  const otpSecret =
    env.OTP_SECRET ?? (production ? "" : "onlylove-development-secret");
  const port = Number(env.PORT ?? 3100);
  const agentInputTokenBudget = Number(env.AGENT_INPUT_TOKEN_BUDGET ?? 32_768);
  const arkFields = {
    ARK_API_KEY: env.ARK_API_KEY,
    ARK_MODEL_ID: env.ARK_MODEL_ID,
    ARK_INPUT_COST_CNY_PER_MILLION_TOKENS:
      env.ARK_INPUT_COST_CNY_PER_MILLION_TOKENS,
    ARK_OUTPUT_COST_CNY_PER_MILLION_TOKENS:
      env.ARK_OUTPUT_COST_CNY_PER_MILLION_TOKENS,
    ARK_PRICING_EFFECTIVE_DATE: env.ARK_PRICING_EFFECTIVE_DATE,
  };
  const hasArkConfig = Object.values(arkFields).some(Boolean);
  if (hasArkConfig) {
    const missing = Object.entries(arkFields)
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length) {
      throw new Error(`${missing.join(", ")} must be configured together`);
    }
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(superAdminEmail)) {
    throw new Error("SUPER_ADMIN_EMAIL must be a valid email address");
  }
  if (
    production &&
    (otpSecret.length < 32 ||
      otpSecret === "replace-with-a-long-random-value")
  ) {
    throw new Error(
      "OTP_SECRET must contain at least 32 characters and not use the example value in production",
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a valid port");
  }
  if (
    !Number.isInteger(agentInputTokenBudget) ||
    agentInputTokenBudget < 8_192
  ) {
    throw new Error(
      "AGENT_INPUT_TOKEN_BUDGET must be an integer of at least 8192",
    );
  }
  let agentModel: ArkAgentModelOptions | undefined;
  if (hasArkConfig) {
    const baseUrl = (env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3")
      .replace(/\/$/, "");
    const parsedBaseUrl = new URL(baseUrl);
    if (
      parsedBaseUrl.protocol !== "https:" ||
      parsedBaseUrl.hostname !== "ark.cn-beijing.volces.com" ||
      parsedBaseUrl.pathname !== "/api/v3"
    ) {
      throw new Error("ARK_BASE_URL must use the Beijing Ark /api/v3 endpoint");
    }
    const inputCostCnyPerMillionTokens = Number(
      arkFields.ARK_INPUT_COST_CNY_PER_MILLION_TOKENS,
    );
    const outputCostCnyPerMillionTokens = Number(
      arkFields.ARK_OUTPUT_COST_CNY_PER_MILLION_TOKENS,
    );
    const pricingEffectiveDate = arkFields.ARK_PRICING_EFFECTIVE_DATE;
    const parsedPricingDate = new Date(`${pricingEffectiveDate}T00:00:00.000Z`);
    if (
      !Number.isFinite(inputCostCnyPerMillionTokens) ||
      inputCostCnyPerMillionTokens < 0 ||
      !Number.isFinite(outputCostCnyPerMillionTokens) ||
      outputCostCnyPerMillionTokens < 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(pricingEffectiveDate!) ||
      Number.isNaN(parsedPricingDate.valueOf()) ||
      parsedPricingDate.toISOString().slice(0, 10) !== pricingEffectiveDate
    ) {
      throw new Error(
        "Ark pricing must use non-negative numbers and a YYYY-MM-DD effective date",
      );
    }
    if (
      arkFields.ARK_MODEL_ID === "latest" ||
      env.ARK_BACKUP_MODEL_ID === "latest"
    ) {
      throw new Error("Ark model IDs must be fixed versions, not latest");
    }
    agentModel = {
      provider: "volcengine-ark",
      apiKey: arkFields.ARK_API_KEY!,
      model: arkFields.ARK_MODEL_ID!,
      backupModel: env.ARK_BACKUP_MODEL_ID || undefined,
      baseUrl,
      pricing: {
        inputCostCnyPerMillionTokens,
        outputCostCnyPerMillionTokens,
        effectiveDate: pricingEffectiveDate!,
      },
    };
  }
  return {
    agentInputTokenBudget,
    agentModel,
    databaseUrl,
    otpSecret,
    port,
    production,
    superAdminEmail,
  };
}
