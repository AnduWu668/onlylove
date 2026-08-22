import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadRootEnv } from "../src/env.js";
import { AgentEngine } from "../src/modules/agent-engine/engine.js";
import { MemoryMailer } from "../src/modules/members/mailer.js";
import {
  finalizePairEvaluation,
  type PairEvaluationInput,
  type PairEvaluationModelResult,
} from "../src/modules/matching/evaluation.js";
import { PORTRAIT_DIMENSIONS } from "../src/modules/portraits/questions.js";
import type { MatchProfile } from "../src/modules/portraits/schema.js";
import { emptyPortraitDraft } from "../src/modules/portraits/service.js";
import { createPortraitWorker } from "../src/portrait-worker.js";

loadRootEnv();
const configuredTestUrl = process.env.TEST_DATABASE_URL;
const testDatabaseUrl = new URL(
  configuredTestUrl ??
    process.env.DATABASE_URL ??
    "postgres://onlylove:onlylove@localhost:5433/onlylove",
);
if (!configuredTestUrl) testDatabaseUrl.pathname = "/onlylove_test";
const databaseUrl = testDatabaseUrl.toString();

const CORE_HTTP_ROUTES = [
  { method: "GET", url: "/api/health" },
  { method: "POST", url: "/api/auth/login" },
  { method: "POST", url: "/api/auth/otp" },
  { method: "POST", url: "/api/auth/verify" },
  { method: "PUT", url: "/api/auth/password" },
  { method: "GET", url: "/api/session" },
  { method: "DELETE", url: "/api/session" },
  { method: "GET", url: "/api/member/profile" },
  { method: "PUT", url: "/api/member/profile" },
  { method: "GET", url: "/api/member/portrait" },
  { method: "GET", url: "/api/member/portrait/interview" },
  { method: "POST", url: "/api/member/portrait/interview/fixed-answers" },
  { method: "POST", url: "/api/member/portrait/versions" },
  { method: "POST", url: "/api/member/portrait/calibration/:scenarioId" },
  { method: "POST", url: "/api/member/portrait/publish" },
  { method: "DELETE", url: "/api/member/portrait/publish" },
  { method: "GET", url: "/api/member/interview" },
  { method: "POST", url: "/api/member/interview/messages" },
  { method: "GET", url: "/api/member/interview/jobs/:jobId/events" },
  { method: "GET", url: "/api/member/twin" },
  { method: "POST", url: "/api/member/twin/messages" },
  { method: "GET", url: "/api/member/twin/jobs/:jobId/events" },
  { method: "GET", url: "/api/admin/invitations" },
  { method: "POST", url: "/api/admin/invitations" },
  { method: "POST", url: "/api/admin/invitations/:id/revoke" },
  { method: "POST", url: "/api/admin/invitations/:id/reissue" },
  { method: "GET", url: "/api/admin/agent-runs" },
  { method: "GET", url: "/api/admin/agent-jobs/failed" },
  { method: "POST", url: "/api/admin/agent-jobs/:jobId/retry" },
  { method: "POST", url: "/api/admin/agent-jobs/:jobId/assignment" },
] as const;

const MEMBER_PROTECTED_ROUTES = [
  { method: "GET", url: "/api/session" },
  { method: "GET", url: "/api/member/profile" },
  { method: "PUT", url: "/api/member/profile" },
  { method: "GET", url: "/api/member/portrait" },
  { method: "GET", url: "/api/member/portrait/interview" },
  { method: "POST", url: "/api/member/portrait/interview/fixed-answers" },
  { method: "POST", url: "/api/member/portrait/versions" },
  { method: "POST", url: "/api/member/portrait/publish" },
  { method: "DELETE", url: "/api/member/portrait/publish" },
  { method: "GET", url: "/api/member/interview" },
  { method: "POST", url: "/api/member/interview/messages" },
  { method: "GET", url: "/api/member/twin" },
  { method: "POST", url: "/api/member/twin/messages" },
] as const;

const ADMIN_PROTECTED_ROUTES = [
  { method: "GET", url: "/api/admin/invitations" },
  { method: "POST", url: "/api/admin/invitations" },
  { method: "GET", url: "/api/admin/agent-runs" },
  { method: "GET", url: "/api/admin/agent-jobs/failed" },
] as const;

const VALID_PROFILE_UPDATE = {
  profile: {
    nickname: "林夏",
    birthDate: "1990-04-12",
    gender: "female",
    heightCm: 165,
    city: "上海",
    occupation: "产品设计师",
  },
  matchCriteria: {
    desiredGender: "male",
    ageMinimum: 28,
    ageMaximum: 38,
    ageMode: "required",
    heightMinimumCm: null,
    heightMaximumCm: null,
    heightMode: null,
    acceptableCities: ["上海", "杭州"],
    occupationRequirement: "稳定的专业工作",
    occupationMode: "preferred",
  },
};

function unauthenticatedPayload(url: string) {
  switch (url) {
    case "/api/member/profile":
      return VALID_PROFILE_UPDATE;
    case "/api/member/portrait/interview/fixed-answers":
      return {
        questionId: "future-change",
        selectedOptionIds: ["plan-together"],
        noneApplies: false,
        freeText: "",
      };
    case "/api/member/portrait/versions":
      return { clientRequestId: randomUUID() };
    case "/api/member/portrait/publish":
      return { versionId: randomUUID() };
    case "/api/member/interview/messages":
    case "/api/member/twin/messages":
      return { clientMessageId: randomUUID(), content: "先发一条消息。" };
    default:
      return undefined;
  }
}

function cookieFrom(response: { cookies: Array<{ name: string; value: string }> }) {
  return `${response.cookies[0]?.name}=${response.cookies[0]?.value}`;
}

function hiddenPortraitLeak(body: unknown) {
  return /selfTendency|partnerExpectation|hardBoundary|evidenceMessageIds|matchProfile/.test(
    JSON.stringify(body),
  );
}

function matchProfile(overrides?: {
  confidence?: MatchProfile["dimensions"][keyof MatchProfile["dimensions"]]["confidence"];
  hardBoundary?: string | null;
  importance?: number;
}): MatchProfile {
  return {
    schemaVersion: "match-profile-v1",
    dimensions: Object.fromEntries(
      PORTRAIT_DIMENSIONS.map((dimension) => [
        dimension,
        {
          selfTendency: "愿意协商",
          partnerExpectation: "愿意协商",
          hardBoundary: overrides?.hardBoundary ?? null,
          importance: overrides?.importance ?? 3,
          confidence: overrides?.confidence ?? "high",
          evidenceMessageIds: ["hidden-evidence-id"],
          contradictions: [],
        },
      ]),
    ) as MatchProfile["dimensions"],
  };
}

function structuredCriteria(
  gender: "female" | "male",
): PairEvaluationInput["memberA"]["structuredCriteria"] {
  return {
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
  };
}

function pairInput(): PairEvaluationInput {
  return {
    memberA: {
      matchProfile: matchProfile({ hardBoundary: "不接受隐瞒债务" }),
      structuredCriteria: structuredCriteria("female"),
    },
    memberB: {
      matchProfile: matchProfile(),
      structuredCriteria: structuredCriteria("male"),
    },
    rubric: { version: "matching-rubric-v0", content: "测试规则" },
  };
}

function pairModelOutput(
  hardBoundaryStatus: PairEvaluationModelResult["dimensions"][number]["hardBoundaryStatus"],
): PairEvaluationModelResult {
  return {
    schemaVersion: "pair-evaluation-schema-v0",
    rubricVersion: "matching-rubric-v0",
    structuredConditionStatus: "pass",
    dimensions: PORTRAIT_DIMENSIONS.map((dimension) => ({
      dimension,
      aToB: 80,
      bToA: 20,
      interactionReason: "两人的协商节奏需要进一步磨合。",
      hardBoundaryStatus,
    })),
    safeRecommendationReason: "内部完整理由不应原样返回给成员。",
  };
}

describe("issue 1-8 core API contract", () => {
  let app: FastifyInstance;
  let mailer: MemoryMailer;
  let worker: Awaited<ReturnType<typeof createPortraitWorker>>;

  async function signIn(email: string, birthDate?: string) {
    const challenge = await app.inject({
      method: "POST",
      url: "/api/auth/otp",
      payload: { email },
    });
    const verified = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: {
        email,
        challengeId: challenge.json().challengeId,
        code: mailer.lastCodeFor(email),
        birthDate,
      },
    });
    const cookie = cookieFrom(verified);
    const password = await app.inject({
      method: "PUT",
      url: "/api/auth/password",
      headers: { cookie },
      payload: { password: "secure-pass-123" },
    });
    expect(password.statusCode).toBe(200);
    return cookie;
  }

  async function inviteAndSignInMember(email: string) {
    const adminCookie = await signIn("admin@onlylove.test");
    const invitation = await app.inject({
      method: "POST",
      url: "/api/admin/invitations",
      headers: { cookie: adminCookie },
      payload: { email },
    });
    expect(invitation.statusCode).toBe(201);
    return {
      adminCookie,
      memberCookie: await signIn(email, "1990-01-01"),
    };
  }

  async function completeFixedInterview(cookie: string) {
    for (;;) {
      const state = await app.inject({
        method: "GET",
        url: "/api/member/portrait/interview",
        headers: { cookie },
      });
      expect(state.statusCode).toBe(200);
      if (state.json().fixedInterview.completed) return state.json();
      const question = state.json().fixedInterview.question as {
        id: string;
        options: { id: string }[];
      };
      const response = await app.inject({
        method: "POST",
        url: "/api/member/portrait/interview/fixed-answers",
        headers: { cookie },
        payload: {
          questionId: question.id,
          selectedOptionIds: [question.options[0]!.id],
          noneApplies: false,
          freeText: state.json().fixedInterview.answered
            ? ""
            : "这段原始访谈不能复制进分身上下文。",
        },
      });
      expect(response.statusCode).toBe(200);
      if (response.json().autoFollowup) {
        const events = await app.inject({
          method: "GET",
          url: response.json().autoFollowup.eventsUrl,
          headers: { cookie },
        });
        expect(events.statusCode).toBe(200);
      }
    }
  }

  async function finishPortraitGeneration(cookie: string) {
    await worker.drain();
    return app.inject({
      method: "GET",
      url: "/api/member/portrait",
      headers: { cookie },
    });
  }

  beforeAll(async () => {
    const migrationApp = await createApp({
      databaseUrl,
      mailer: new MemoryMailer(),
      otpSecret: "test-only-secret",
      superAdminEmail: "admin@onlylove.test",
    });
    await migrationApp.close();
  });

  beforeEach(async () => {
    if (worker) await worker.close();
    if (app) await app.close();
    const pool = new Pool({ connectionString: databaseUrl });
    await pool.query(
      "TRUNCATE portrait_fixed_answers, portrait_drafts, agent_runs, agent_jobs, own_agent_daily_quotas, conversation_messages, conversations, sessions, otp_challenges, invitations, members CASCADE",
    );
    await pool.end();
    const draft = emptyPortraitDraft();
    for (const [dimension, value] of Object.entries(draft)) {
      value.selfTendency = `我会根据${dimension}的具体情境做决定。`;
      value.partnerExpectation = `希望对方愿意讨论${dimension}。`;
    }
    mailer = new MemoryMailer();
    const agentModel = {
      provider: "deterministic-fake" as const,
      model: "core-contract-v1",
      reply: "我是 AI 恋爱分身。我会先说明需要独处，再约定重新沟通的时间。",
      extractReply: JSON.stringify(draft),
    };
    app = await createApp({
      databaseUrl,
      mailer,
      otpSecret: "test-only-secret",
      superAdminEmail: "admin@onlylove.test",
      now: () => new Date("2026-08-21T08:00:00.000Z"),
      agentModel,
    });
    worker = await createPortraitWorker({
      databaseUrl,
      now: () => new Date("2026-08-21T08:00:00.000Z"),
      agentModel,
    });
    await app.ready();
  });

  afterAll(async () => {
    if (worker) await worker.close();
    if (app) await app.close();
  });

  it("registers every HTTP route shipped through issue 8", () => {
    for (const route of CORE_HTTP_ROUTES) {
      expect(app.hasRoute(route), `${route.method} ${route.url}`).toBe(true);
    }
  });

  it("rejects anonymous members and non-admins on protected routes", async () => {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });

    for (const route of MEMBER_PROTECTED_ROUTES) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        payload: unauthenticatedPayload(route.url),
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect(response.json()).toEqual({ code: "UNAUTHENTICATED" });
    }

    for (const route of ADMIN_PROTECTED_ROUTES) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        payload: route.method === "POST" ? { email: "x@onlylove.test" } : undefined,
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(response.json()).toEqual({ code: "FORBIDDEN" });
    }
  });

  it("walks the issue 1-8 member lifecycle without changing response contracts", async () => {
    const { adminCookie, memberCookie: cookie } =
      await inviteAndSignInMember("core@onlylove.test");

    const session = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      member: { email: "core@onlylove.test", role: "member" },
      requiresPasswordSetup: false,
    });

    const passwordLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "core@onlylove.test", password: "secure-pass-123" },
    });
    expect(passwordLogin.statusCode).toBe(200);
    expect(passwordLogin.json()).toMatchObject({
      member: { email: "core@onlylove.test" },
      requiresPasswordSetup: false,
    });

    const savedProfile = await app.inject({
      method: "PUT",
      url: "/api/member/profile",
      headers: { cookie },
      payload: VALID_PROFILE_UPDATE,
    });
    expect(savedProfile.statusCode).toBe(200);
    expect(savedProfile.json()).toMatchObject({
      profile: VALID_PROFILE_UPDATE.profile,
      matchCriteria: { ...VALID_PROFILE_UPDATE.matchCriteria, version: 1 },
    });
    const readProfile = await app.inject({
      method: "GET",
      url: "/api/member/profile",
      headers: { cookie },
    });
    expect(readProfile.statusCode).toBe(200);
    expect(readProfile.json()).toEqual(savedProfile.json());

    const memberCannotInvite = await app.inject({
      method: "POST",
      url: "/api/admin/invitations",
      headers: { cookie },
      payload: { email: "other@onlylove.test" },
    });
    expect(memberCannotInvite.statusCode).toBe(403);

    await completeFixedInterview(cookie);
    const interview = await app.inject({
      method: "GET",
      url: "/api/member/interview",
      headers: { cookie },
    });
    expect(interview.statusCode).toBe(200);
    expect(interview.json().fixedInterview.completed).toBe(true);
    expect(interview.json().progress).toMatchObject({ total: 8 });
    expect(hiddenPortraitLeak(interview.json())).toBe(false);

    const interviewMessage = await app.inject({
      method: "POST",
      url: "/api/member/interview/messages",
      headers: { cookie },
      payload: {
        clientMessageId: "30b57ed8-9909-4fc2-ab5c-3c951ecf4297",
        content: "冲突时我会先冷静，再约定重新沟通的时间。",
      },
    });
    expect(interviewMessage.statusCode).toBe(202);
    expect(interviewMessage.json()).toMatchObject({
      conversationId: expect.any(String),
      jobId: expect.any(String),
      eventsUrl: expect.stringMatching(/^\/api\/member\/interview\/jobs\/.+\/events$/),
      quotaRemaining: expect.any(Number),
    });
    const interviewEvents = await app.inject({
      method: "GET",
      url: interviewMessage.json().eventsUrl,
      headers: { cookie },
    });
    expect(interviewEvents.statusCode).toBe(200);
    expect(interviewEvents.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(interviewEvents.body).toContain("event: done");

    const unpublishedTwin = await app.inject({
      method: "GET",
      url: "/api/member/twin",
      headers: { cookie },
    });
    expect(unpublishedTwin.statusCode).toBe(409);
    expect(unpublishedTwin.json()).toEqual({ code: "TWIN_NOT_PUBLISHED" });

    const accepted = await app.inject({
      method: "POST",
      url: "/api/member/portrait/versions",
      headers: { cookie },
      payload: { clientRequestId: "f6148226-ef5d-496c-9c9e-fe9e9aebac8a" },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({
      status: "generating",
      submittedVersion: { version: 1 },
    });
    expect(hiddenPortraitLeak(accepted.json())).toBe(false);

    const generated = await finishPortraitGeneration(cookie);
    expect(generated.statusCode).toBe(200);
    expect(generated.json()).toMatchObject({
      status: "calibrating",
      submittedVersion: { version: 1 },
      publishedVersion: null,
      calibration: { answered: 0, total: 10, likeCount: 0, canPublish: false },
    });
    expect(hiddenPortraitLeak(generated.json())).toBe(false);

    let lifecycle = generated.json();
    for (const scenario of lifecycle.calibration.scenarios) {
      const answered = await app.inject({
        method: "POST",
        url: `/api/member/portrait/calibration/${scenario.id}`,
        headers: { cookie },
        payload: {
          rating: "like",
          correction: "",
          criticalFabrication: false,
        },
      });
      expect(answered.statusCode).toBe(200);
      lifecycle = answered.json();
    }
    expect(lifecycle).toMatchObject({
      status: "ready_to_publish",
      calibration: { likeCount: 10, canPublish: true },
    });

    const published = await app.inject({
      method: "POST",
      url: "/api/member/portrait/publish",
      headers: { cookie },
      payload: { versionId: lifecycle.submittedVersion.id },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({
      status: "published",
      publishedVersion: { id: lifecycle.submittedVersion.id, version: 1 },
    });

    const emptyTwin = await app.inject({
      method: "GET",
      url: "/api/member/twin",
      headers: { cookie },
    });
    expect(emptyTwin.statusCode).toBe(200);
    expect(emptyTwin.json()).toMatchObject({
      conversationId: null,
      profileVersion: { id: lifecycle.submittedVersion.id, version: 1 },
      messages: [],
    });

    const twinMessage = await app.inject({
      method: "POST",
      url: "/api/member/twin/messages",
      headers: { cookie },
      payload: {
        clientMessageId: "44b6066a-85a4-4bd1-9fb5-d8feab8e4899",
        content: "这不像我，我会先说明需要独处。",
      },
    });
    expect(twinMessage.statusCode).toBe(202);
    expect(twinMessage.json()).toMatchObject({
      conversationId: expect.any(String),
      jobId: expect.any(String),
      eventsUrl: expect.stringMatching(/^\/api\/member\/twin\/jobs\/.+\/events$/),
      quotaRemaining: expect.any(Number),
    });
    const twinEvents = await app.inject({
      method: "GET",
      url: twinMessage.json().eventsUrl,
      headers: { cookie },
    });
    expect(twinEvents.statusCode).toBe(200);
    expect(twinEvents.body).toContain("event: done");

    const twinConversation = await app.inject({
      method: "GET",
      url: "/api/member/twin",
      headers: { cookie },
    });
    expect(twinConversation.json()).toMatchObject({
      profileVersion: { id: lifecycle.submittedVersion.id, version: 1 },
      messages: [
        expect.objectContaining({
          role: "member",
          content: "这不像我，我会先说明需要独处。",
        }),
        expect.objectContaining({ role: "agent" }),
      ],
    });

    const runs = await app.inject({
      method: "GET",
      url: "/api/admin/agent-runs",
      headers: { cookie: adminCookie },
    });
    expect(runs.statusCode).toBe(200);
    expect(runs.json().runs.length).toBeGreaterThan(0);
    expect(JSON.stringify(runs.json())).not.toMatch(/ARK_API_KEY|api[_ -]?key/i);

    const failedJobs = await app.inject({
      method: "GET",
      url: "/api/admin/agent-jobs/failed",
      headers: { cookie: adminCookie },
    });
    expect(failedJobs.statusCode).toBe(200);
    expect(failedJobs.json()).toEqual({ jobs: [] });

    const invitations = await app.inject({
      method: "GET",
      url: "/api/admin/invitations",
      headers: { cookie: adminCookie },
    });
    expect(invitations.statusCode).toBe(200);
    expect(invitations.json().invitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          email: "core@onlylove.test",
          status: "used",
        }),
      ]),
    );

    const signOut = await app.inject({
      method: "DELETE",
      url: "/api/session",
      headers: { cookie },
    });
    expect(signOut.statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/session",
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("keeps evaluatePair as the matching Agent Engine contract", async () => {
    const input = pairInput();
    const modelOutput = pairModelOutput("pass");
    const engine = new AgentEngine({
      provider: "deterministic-fake",
      model: "matching-v0",
      attempts: [
        {
          reply: JSON.stringify(modelOutput),
          promptIncludes: ["匹配评判规则版本", "测试规则"],
          promptExcludes: ["hidden-evidence-id"],
        },
      ],
    });

    const result = await engine.evaluatePair(input, async () => undefined);
    expect(result.value).toMatchObject({
      schemaVersion: "pair-evaluation-schema-v0",
      aToBScore: 80,
      bToAScore: 20,
      reciprocalScore: 32,
      eligibility: "eligible",
    });
    engine.close();

    const excluded = finalizePairEvaluation(input, pairModelOutput("conflict"));
    expect(excluded.eligibility).toBe("excluded");
    expect(excluded.safeRecommendationReason).toBe(
      "当前条件不支持形成候选推荐。",
    );
    expect(excluded.safeRecommendationReason).not.toMatch(/\d|分数|标签|证据/);
  });
});
