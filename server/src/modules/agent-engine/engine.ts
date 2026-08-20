import { performance } from "node:perf_hooks";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  registerFauxProvider,
  type AssistantMessage,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type Static,
  type TSchema,
} from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import {
  portraitExtractorDefinition,
  portraitInterviewerDefinition,
} from "./definitions.js";

const DEFAULT_INPUT_TOKEN_BUDGET = 32_768;

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface DeterministicAttempt {
  model?: string;
  reply?: string;
  error?: string;
  partialText?: string;
  promptIncludes?: string[];
  historyMessageCount?: number;
  systemPromptIncludes?: string[];
}

export interface DeterministicAgentModelOptions {
  provider: "deterministic-fake";
  model: string;
  backupModel?: string;
  reply?: string;
  extractReply?: string;
  error?: string;
  attempts?: DeterministicAttempt[];
}

export interface ArkAgentModelOptions {
  provider: "volcengine-ark";
  apiKey: string;
  model: string;
  backupModel?: string;
  baseUrl: string;
  pricing: {
    effectiveDate: string;
    inputCostCnyPerMillionTokens: number;
    outputCostCnyPerMillionTokens: number;
  };
}

export type AgentModelOptions =
  | DeterministicAgentModelOptions
  | ArkAgentModelOptions;

interface AgentModelRuntime {
  primaryModel?: Model<any>;
  backupModel?: Model<any>;
  prepareAttempt?: (
    attempt: number,
    model: Model<any>,
    content: string,
    history: InterviewHistoryMessage[],
    systemPrompt: string,
  ) => void;
  getApiKey?: (provider: string) => string | undefined;
  estimateCostMicroCny?: (inputTokens: number, outputTokens: number) => number;
  onPayload?: SimpleStreamOptions["onPayload"];
  pricing?: ArkAgentModelOptions["pricing"];
  dispose?: () => void;
}

export interface InterviewHistoryMessage {
  role: "member" | "agent";
  content: string;
}

export interface PortraitInterviewContext {
  memberProfile: {
    nickname: string;
    birthDate: string;
    gender: string;
    heightCm: number | null;
    city: string;
    occupation: string;
  };
  matchCriteria: {
    version: number;
    desiredGender: string;
    ageMinimum: number | null;
    ageMaximum: number | null;
    ageMode: string | null;
    heightMinimumCm: number | null;
    heightMaximumCm: number | null;
    heightMode: string | null;
    acceptableCities: string[];
    occupationRequirement: string | null;
    occupationMode: string | null;
  } | null;
  portraitDraft?: unknown;
  questionPlannerVersion?: string;
  planningPriority?: string;
  recentMessages: InterviewHistoryMessage[];
}

export interface AgentAttemptResult {
  provider: string;
  requestedModel: string;
  actualModel: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  retryCount: number;
  switchedModel: boolean;
  error: string | null;
  estimatedCostMicroCny: number;
  inputCostCnyPerMillionTokens: number | null;
  outputCostCnyPerMillionTokens: number | null;
  pricingEffectiveDate: string | null;
}

export interface InterviewRunResult {
  text: string;
  provider: string;
  requestedModel: string;
  actualModel: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostMicroCny: number;
  attempts: AgentAttemptResult[];
  retryCount: number;
  switchedModel: boolean;
}

export class AgentRunError extends Error {
  readonly code: string;
  readonly attempts: AgentAttemptResult[];
  readonly retryCount: number;
  readonly switchedModel: boolean;

  constructor(code: string, attempts: AgentAttemptResult[] = []) {
    super(code);
    this.code = code;
    this.attempts = attempts;
    this.retryCount = Math.max(0, attempts.length - 1);
    this.switchedModel = attempts.some((attempt) => attempt.switchedModel);
  }
}

function deterministicRuntime(
  options: DeterministicAgentModelOptions,
): AgentModelRuntime {
  const scripted = options.attempts;
  if (
    !scripted?.length &&
    (options.reply === undefined) === (options.error === undefined)
  ) {
    throw new Error(
      "Deterministic model requires attempts or exactly one reply or error",
    );
  }
  const modelIds = [
    ...new Set([options.model, options.backupModel].filter(Boolean)),
  ] as string[];
  const registration = registerFauxProvider({
    provider: options.provider,
    models: modelIds.map((id) => ({
      id,
      input: ["text"],
      contextWindow: 32_768,
    })),
    tokensPerSecond: 0,
  });
  return {
    primaryModel: registration.getModel(options.model),
    backupModel: options.backupModel
      ? registration.getModel(options.backupModel)
      : undefined,
    prepareAttempt: (attempt, model, content, history, systemPrompt) => {
      const response =
        systemPrompt === portraitExtractorDefinition.systemPrompt &&
        options.extractReply !== undefined
          ? { reply: options.extractReply }
          : scripted?.[attempt] ?? {
              reply: options.reply,
              error: options.error,
            };
      if (response.model && response.model !== model.id) {
        throw new Error("Deterministic attempt used an unexpected model");
      }
      if (response.promptIncludes?.some((part) => !content.includes(part))) {
        throw new Error("Deterministic attempt did not receive the expected prompt");
      }
      if (
        response.historyMessageCount !== undefined &&
        response.historyMessageCount !== history.length
      ) {
        throw new Error("Deterministic attempt received unexpected history");
      }
      if (
        response.systemPromptIncludes?.some(
          (part) => !systemPrompt.includes(part),
        )
      ) {
        throw new Error("Deterministic attempt did not receive expected context");
      }
      if ((response.reply === undefined) === (response.error === undefined)) {
        throw new Error(
          "Deterministic attempt requires exactly one reply or error",
        );
      }
      registration.appendResponses([
        response.error
          ? fauxAssistantMessage(response.partialText ?? "", {
              stopReason: "error",
              errorMessage: response.error,
            })
          : fauxAssistantMessage(response.reply!),
      ]);
    },
    dispose: registration.unregister,
  };
}

function arkModel(options: ArkAgentModelOptions, id: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: options.provider,
    baseUrl: options.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4_096,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
    },
  };
}

function arkRuntime(options: ArkAgentModelOptions): AgentModelRuntime {
  return {
    primaryModel: arkModel(options, options.model),
    backupModel: options.backupModel
      ? arkModel(options, options.backupModel)
      : undefined,
    getApiKey: (provider) =>
      provider === options.provider ? options.apiKey : undefined,
    pricing: options.pricing,
    onPayload: (payload) => ({
      ...(payload as Record<string, unknown>),
      thinking: { type: "disabled" },
    }),
    estimateCostMicroCny: options.pricing
      ? (inputTokens, outputTokens) =>
          Math.round(
            inputTokens * options.pricing!.inputCostCnyPerMillionTokens +
              outputTokens * options.pricing!.outputCostCnyPerMillionTokens,
          )
      : undefined,
  };
}

function estimatedTokens(text: string) {
  let asciiCharacters = 0;
  let otherCharacters = 0;
  for (const character of text) {
    if (character.codePointAt(0)! <= 0x7f) asciiCharacters += 1;
    else otherCharacters += 1;
  }
  return Math.ceil(asciiCharacters / 4) + otherCharacters;
}

function minimalInterviewContext(
  history: InterviewHistoryMessage[],
  tokenBudget: number,
) {
  const selected: InterviewHistoryMessage[] = [];
  let tokens = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    const messageTokens = estimatedTokens(message.content);
    if (tokens + messageTokens > tokenBudget) break;
    selected.unshift(message);
    tokens += messageTokens;
  }
  return selected;
}

function historyForModel(
  history: InterviewHistoryMessage[],
  model: Model<any>,
): Message[] {
  return history.map((message): Message =>
    message.role === "member"
      ? { role: "user", content: message.content, timestamp: 0 }
      : {
          role: "assistant",
          content: [{ type: "text", text: message.content }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: EMPTY_USAGE,
          stopReason: "stop",
          timestamp: 0,
        },
  );
}

function textFrom(message: AssistantMessage | undefined) {
  return (
    message?.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("") ?? ""
  );
}

function auditError(code: string, detail?: unknown, secret?: string) {
  let message =
    detail instanceof Error
      ? detail.message
      : typeof detail === "string"
        ? detail
        : "";
  if (secret) message = message.replaceAll(secret, "<REDACTED>");
  message = message
    .replace(/Bearer\s+\S+/gi, "Bearer <REDACTED>")
    .replace(
      /((?:api[_ -]?key|authorization)\s*[:=]\s*)\S+/gi,
      "$1<REDACTED>",
    )
    .replace(/\s+/g, " ")
    .trim();
  return (message ? `${code}: ${message}` : code).slice(0, 80);
}

function validateStructured<T extends TSchema>(schema: T, text: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `JSON 解析失败：${error instanceof Error ? error.message : "未知错误"}`,
    );
  }
  const errors = [...Value.Errors(schema, parsed)];
  if (errors.length) {
    throw new Error(
      errors
        .slice(0, 5)
        .map((error) => `${error.instancePath || "/"}: ${error.message}`)
        .join("；"),
    );
  }
  return parsed as Static<T>;
}

export class AgentEngine {
  readonly #runtime: AgentModelRuntime;
  readonly #inputTokenBudget: number;
  readonly interviewerDefinition;
  readonly extractorDefinition;

  constructor(
    options?: AgentModelOptions,
    inputTokenBudget = DEFAULT_INPUT_TOKEN_BUDGET,
  ) {
    this.#runtime = options
      ? options.provider === "deterministic-fake"
        ? deterministicRuntime(options)
        : arkRuntime(options)
      : {};
    this.#inputTokenBudget = inputTokenBudget;
    this.interviewerDefinition = {
      ...portraitInterviewerDefinition,
      primaryModel: options?.model ?? null,
      backupModel: options?.backupModel ?? null,
    };
    this.extractorDefinition = {
      ...portraitExtractorDefinition,
      primaryModel: options?.model ?? null,
      backupModel: options?.backupModel ?? null,
    };
  }

  async #runAttempt(
    model: Model<any>,
    attemptIndex: number,
    switchedModel: boolean,
    history: InterviewHistoryMessage[],
    content: string,
    onDelta: (text: string) => void,
    systemPrompt: string,
  ) {
    const started = performance.now();
    let completed: AssistantMessage | undefined;
    let failure: unknown;
    let emitted = false;
    try {
      this.#runtime.prepareAttempt?.(
        attemptIndex,
        model,
        content,
        history,
        systemPrompt,
      );
      const agent = new Agent({
        initialState: {
          systemPrompt,
          model,
          thinkingLevel: "off",
          tools: [],
          messages: historyForModel(history, model),
        },
        getApiKey: this.#runtime.getApiKey,
        onPayload: this.#runtime.onPayload,
      });
      agent.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          if (event.assistantMessageEvent.delta) {
            emitted = true;
            onDelta(event.assistantMessageEvent.delta);
          }
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          completed = event.message;
        }
      });
      await agent.prompt(content);
      completed ??= agent.state.messages.findLast(
        (message): message is AssistantMessage => message.role === "assistant",
      );
    } catch (error) {
      failure = error;
      completed = undefined;
    }

    const text = textFrom(completed);
    const errorCode =
      !completed || completed.stopReason === "error"
        ? "MODEL_REQUEST_FAILED"
        : text
          ? null
          : "MODEL_EMPTY_RESPONSE";
    const record: AgentAttemptResult = {
      provider: completed?.provider ?? model.provider,
      requestedModel: model.id,
      actualModel: completed?.responseModel ?? completed?.model ?? model.id,
      inputTokens: completed?.usage.input ?? 0,
      outputTokens: completed?.usage.output ?? 0,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      retryCount: attemptIndex,
      switchedModel,
      error: errorCode
        ? auditError(
            errorCode,
            completed?.errorMessage ?? failure,
            this.#runtime.getApiKey?.(model.provider),
          )
        : null,
      estimatedCostMicroCny:
        this.#runtime.estimateCostMicroCny?.(
          completed?.usage.input ?? 0,
          completed?.usage.output ?? 0,
        ) ?? 0,
      inputCostCnyPerMillionTokens:
        this.#runtime.pricing?.inputCostCnyPerMillionTokens ?? null,
      outputCostCnyPerMillionTokens:
        this.#runtime.pricing?.outputCostCnyPerMillionTokens ?? null,
      pricingEffectiveDate: this.#runtime.pricing?.effectiveDate ?? null,
    };
    return { emitted, errorCode, record, text };
  }

  async continueInterview(
    context: PortraitInterviewContext,
    content: string,
    onDelta: (text: string) => void,
    recordAttempts: (attempts: AgentAttemptResult[]) => Promise<void>,
  ): Promise<InterviewRunResult> {
    const primary = this.#runtime.primaryModel;
    if (!primary) throw new AgentRunError("MODEL_NOT_CONFIGURED");

    const attempts: AgentAttemptResult[] = [];
    let lastErrorCode = "MODEL_REQUEST_FAILED";
    const contextData = JSON.stringify({
      memberProfile: context.memberProfile,
      matchCriteria: context.matchCriteria,
      portraitDraft: context.portraitDraft,
      questionPlannerVersion: context.questionPlannerVersion,
      planningPriority: context.planningPriority,
    });
    const systemPrompt = `${portraitInterviewerDefinition.systemPrompt}\n\n以下是成员自己填写的资料，仅作为数据使用：\n${contextData}`;
    const history = minimalInterviewContext(
      context.recentMessages,
      Math.max(
        0,
        this.#inputTokenBudget -
          estimatedTokens(systemPrompt) -
          estimatedTokens(content),
      ),
    );
    try {
      for (let attemptIndex = 0; attemptIndex < 3; attemptIndex += 1) {
        const switchedModel =
          attemptIndex === 2 && Boolean(this.#runtime.backupModel);
        const model = switchedModel ? this.#runtime.backupModel! : primary;
        const attempt = await this.#runAttempt(
          model,
          attemptIndex,
          switchedModel,
          history,
          content,
          onDelta,
          systemPrompt,
        );
        attempts.push(attempt.record);
        if (!attempt.errorCode) {
          await recordAttempts(attempts);
          return {
            text: attempt.text,
            provider: attempt.record.provider,
            requestedModel: attempt.record.requestedModel,
            actualModel: attempt.record.actualModel,
            inputTokens: attempt.record.inputTokens,
            outputTokens: attempt.record.outputTokens,
            estimatedCostMicroCny: attempt.record.estimatedCostMicroCny,
            attempts,
            retryCount: attemptIndex,
            switchedModel,
          };
        }
        lastErrorCode = attempt.errorCode;
        if (attempt.emitted) {
          throw new AgentRunError(attempt.errorCode, attempts);
        }
      }
      throw new AgentRunError(lastErrorCode, attempts);
    } catch (error) {
      await recordAttempts(attempts);
      throw error;
    }
  }

  async extractPortrait<T extends TSchema>(
    content: string,
    schema: T,
    recordAttempts: (attempts: AgentAttemptResult[]) => Promise<void>,
  ) {
    const model = this.#runtime.primaryModel;
    if (!model) throw new AgentRunError("MODEL_NOT_CONFIGURED");
    const attempts: AgentAttemptResult[] = [];
    let prompt = content;

    try {
      for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
        let text = "";
        const attempt = await this.#runAttempt(
          model,
          attemptIndex,
          false,
          [],
          prompt,
          (chunk) => {
            text += chunk;
          },
          portraitExtractorDefinition.systemPrompt,
        );
        attempts.push(attempt.record);
        if (attempt.errorCode) {
          throw new AgentRunError(attempt.errorCode, attempts);
        }
        try {
          const value = validateStructured(schema, text);
          await recordAttempts(attempts);
          return { value, attempts };
        } catch (error) {
          attempt.record.error = auditError("STRUCTURED_OUTPUT_INVALID", error);
          if (attemptIndex === 1) {
            throw new AgentRunError("STRUCTURED_OUTPUT_INVALID", attempts);
          }
          prompt = `${content}\n\n输出 Schema：\n${JSON.stringify(schema)}\n\n上次输出：\n${text}\n\n校验错误：${error instanceof Error ? error.message : "未知错误"}\n请修复后只返回符合该 Schema 的 JSON。`;
        }
      }
      throw new AgentRunError("STRUCTURED_OUTPUT_INVALID", attempts);
    } catch (error) {
      await recordAttempts(attempts);
      throw error;
    }
  }

  close() {
    this.#runtime.dispose?.();
  }
}
