import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadRootEnv } from "../src/env.js";
import { MemoryMailer } from "../src/modules/members/mailer.js";
import { emptyPortraitDraft } from "../src/modules/portraits/service.js";

loadRootEnv();
const configuredTestUrl = process.env.TEST_DATABASE_URL;
const testDatabaseUrl = new URL(
  configuredTestUrl ??
    process.env.DATABASE_URL ??
    "postgres://onlylove:onlylove@localhost:5433/onlylove",
);
if (!configuredTestUrl) testDatabaseUrl.pathname = "/onlylove_test";
const databaseUrl = testDatabaseUrl.toString();

describe("portrait submission, calibration, and publication HTTP seam", () => {
  let app: FastifyInstance;
  let mailer: MemoryMailer;

  async function signIn(email: string, birthDate?: string) {
    const challenge = await app.inject({
      method: "POST",
      url: "/api/auth/otp",
      payload: { email },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: {
        email,
        challengeId: challenge.json().challengeId,
        code: mailer.lastCodeFor(email),
        birthDate,
      },
    });
    const cookie = response.cookies[0]?.name + "=" + response.cookies[0]?.value;
    await app.inject({
      method: "PUT",
      url: "/api/auth/password",
      headers: { cookie },
      payload: { password: "secure-pass-123" },
    });
    return cookie;
  }

  async function inviteAndSignInMember(email: string) {
    const adminCookie = await signIn("admin@onlylove.test");
    await app.inject({
      method: "POST",
      url: "/api/admin/invitations",
      headers: { cookie: adminCookie },
      payload: { email },
    });
    return signIn(email, "1990-01-01");
  }

  async function completeFixedInterview(cookie: string) {
    for (;;) {
      const state = await app.inject({
        method: "GET",
        url: "/api/member/portrait/interview",
        headers: { cookie },
      });
      if (state.json().fixedInterview.completed) return;
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
      if (response.json().autoFollowup) {
        await app.inject({
          method: "GET",
          url: response.json().autoFollowup.eventsUrl,
          headers: { cookie },
        });
      }
    }
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
    app = await createApp({
      databaseUrl,
      mailer,
      otpSecret: "test-only-secret",
      superAdminEmail: "admin@onlylove.test",
      now: () => new Date("2026-08-21T08:00:00.000Z"),
      agentModel: {
        provider: "deterministic-fake",
        model: "portrait-test-v1",
        reply: "你愿意再说一个具体例子吗？",
        extractReply: JSON.stringify(draft),
      },
    });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("creates one immutable version only after an idempotent manual submission", async () => {
    const cookie = await inviteAndSignInMember("submit@onlylove.test");
    const initial = await app.inject({
      method: "GET",
      url: "/api/member/portrait",
      headers: { cookie },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({
      status: "draft",
      submittedVersion: null,
      publishedVersion: null,
    });

    await completeFixedInterview(cookie);
    const payload = {
      clientRequestId: "f6148226-ef5d-496c-9c9e-fe9e9aebac8a",
    };
    const submitted = await app.inject({
      method: "POST",
      url: "/api/member/portrait/versions",
      headers: { cookie },
      payload,
    });
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json()).toMatchObject({
      status: "calibrating",
      submittedVersion: { version: 1 },
      publishedVersion: null,
      calibration: { answered: 0, total: 10, likeCount: 0 },
    });
    expect(submitted.json().calibration.scenarios).toHaveLength(10);
    expect(
      new Set(
        submitted
          .json()
          .calibration.scenarios.flatMap(
            (scenario: { dimensions: string[] }) => scenario.dimensions,
          ),
      ),
    ).toEqual(
      new Set([
        "long_term_planning",
        "values",
        "relationship_boundaries",
        "communication",
        "conflict_repair",
        "emotional_support",
        "lifestyle",
        "family_and_finance",
      ]),
    );
    expect(
      submitted
        .json()
        .calibration.scenarios.filter(
          (scenario: { dimensions: string[] }) => scenario.dimensions.length === 2,
        ),
    ).toHaveLength(2);
    expect(JSON.stringify(submitted.json())).not.toMatch(
      /matchProfile|personaContext|evidenceMessageIds|partnerExpectation/,
    );

    const repeated = await app.inject({
      method: "POST",
      url: "/api/member/portrait/versions",
      headers: { cookie },
      payload,
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().submittedVersion.id).toBe(
      submitted.json().submittedVersion.id,
    );

    const pool = new Pool({ connectionString: databaseUrl });
    const versions = await pool.query<{
      match_profile: { schemaVersion: string };
      persona_context: string;
      persona_context_schema_version: string;
    }>(
      "select match_profile, persona_context, persona_context_schema_version from portrait_versions",
    );
    await pool.end();
    expect(versions.rows).toHaveLength(1);
    expect(versions.rows[0]!.match_profile.schemaVersion).toBe(
      "match-profile-v1",
    );
    expect(versions.rows[0]!.persona_context_schema_version).toBe(
      "persona-context-v1",
    );
    expect(versions.rows[0]!.persona_context).not.toContain(
      "这段原始访谈不能复制进分身上下文。",
    );
    expect(versions.rows[0]!.persona_context).not.toMatch(
      /partnerExpectation|evidenceMessageIds|confidence/,
    );
  });

  it("fails calibration on fabrication, keeps focused corrections, and rotates scenarios", async () => {
    const cookie = await inviteAndSignInMember("calibrate@onlylove.test");
    await completeFixedInterview(cookie);
    const submitted = await app.inject({
      method: "POST",
      url: "/api/member/portrait/versions",
      headers: { cookie },
      payload: {
        clientRequestId: "dcb4c812-9230-493b-820d-a2ba4b6871cc",
      },
    });
    const first = submitted.json();
    const scenarios = first.calibration.scenarios as {
      id: string;
      dimensions: string[];
      prompt: string;
    }[];

    const missingCorrection = await app.inject({
      method: "POST",
      url: `/api/member/portrait/calibration/${scenarios[8]!.id}`,
      headers: { cookie },
      payload: {
        rating: "partial",
        correction: "",
        criticalFabrication: false,
      },
    });
    expect(missingCorrection.statusCode).toBe(400);
    expect(missingCorrection.json()).toEqual({
      code: "CALIBRATION_CORRECTION_REQUIRED",
    });

    let state = first;
    for (const [index, scenario] of scenarios.entries()) {
      const unlike = index >= 8;
      const response = await app.inject({
        method: "POST",
        url: `/api/member/portrait/calibration/${scenario.id}`,
        headers: { cookie },
        payload: {
          rating: unlike ? "partial" : "like",
          correction: unlike ? `第 ${index + 1} 题的聚焦纠正` : "",
          criticalFabrication: index === 9,
        },
      });
      expect(response.statusCode).toBe(200);
      state = response.json();
    }

    expect(state).toMatchObject({
      status: "needs_more_understanding",
      message: "分身还需要继续了解你",
      calibration: {
        answered: 10,
        total: 10,
        likeCount: 8,
        criticalFabrication: true,
        canPublish: false,
      },
    });

    const pool = new Pool({ connectionString: databaseUrl });
    const draft = await pool.query<{ content: Record<string, unknown> }>(
      "select content from portrait_drafts",
    );
    await pool.end();
    expect(JSON.stringify(draft.rows[0]!.content)).toContain(
      "第 9 题的聚焦纠正",
    );
    expect(JSON.stringify(draft.rows[0]!.content)).toContain(
      "第 10 题的聚焦纠正",
    );

    const next = await app.inject({
      method: "POST",
      url: "/api/member/portrait/versions",
      headers: { cookie },
      payload: {
        clientRequestId: "1d7ca863-eab8-44c5-8e40-4f4957080448",
      },
    });
    expect(next.statusCode).toBe(201);
    expect(next.json().submittedVersion.version).toBe(2);
    expect(
      next
        .json()
        .calibration.scenarios.map((scenario: { dimensions: string[] }) =>
          scenario.dimensions,
        ),
    ).toEqual(scenarios.map((scenario) => scenario.dimensions));
    expect(
      next
        .json()
        .calibration.scenarios.map((scenario: { prompt: string }) => scenario.prompt),
    ).not.toEqual(scenarios.map((scenario) => scenario.prompt));
  });

  it("publishes only a passing version, atomically replaces it, and withdraws it", async () => {
    const cookie = await inviteAndSignInMember("publish@onlylove.test");
    await completeFixedInterview(cookie);
    const submit = async (clientRequestId: string) =>
      app.inject({
        method: "POST",
        url: "/api/member/portrait/versions",
        headers: { cookie },
        payload: { clientRequestId },
      });
    const calibrate = async (state: any) => {
      let current = state;
      for (const [index, scenario] of state.calibration.scenarios.entries()) {
        const partial = index >= 8;
        const response = await app.inject({
          method: "POST",
          url: `/api/member/portrait/calibration/${scenario.id}`,
          headers: { cookie },
          payload: {
            rating: partial ? "partial" : "like",
            correction: partial ? `第 ${index + 1} 题补充语境` : "",
            criticalFabrication: false,
          },
        });
        current = response.json();
      }
      return current;
    };

    const first = await submit("b6e07c50-1b22-44b4-8dcb-40a2dc9d0e48");
    const ready = await calibrate(first.json());
    expect(ready).toMatchObject({
      status: "ready_to_publish",
      publishedVersion: null,
      calibration: { likeCount: 8, canPublish: true },
    });

    const published = await app.inject({
      method: "POST",
      url: "/api/member/portrait/publish",
      headers: { cookie },
      payload: { versionId: ready.submittedVersion.id },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({
      status: "published",
      publishedVersion: { id: ready.submittedVersion.id, version: 1 },
    });

    const second = await submit("95622e32-f426-4a38-84ca-baa20cfb3115");
    expect(second.json()).toMatchObject({
      status: "calibrating",
      submittedVersion: { version: 2 },
      publishedVersion: { id: ready.submittedVersion.id, version: 1 },
    });
    const premature = await app.inject({
      method: "POST",
      url: "/api/member/portrait/publish",
      headers: { cookie },
      payload: { versionId: second.json().submittedVersion.id },
    });
    expect(premature.statusCode).toBe(409);
    expect(premature.json()).toEqual({ code: "CALIBRATION_NOT_PASSED" });
    const stillPublished = await app.inject({
      method: "GET",
      url: "/api/member/portrait",
      headers: { cookie },
    });
    expect(stillPublished.json().publishedVersion.id).toBe(
      ready.submittedVersion.id,
    );

    const secondReady = await calibrate(second.json());
    const replaced = await app.inject({
      method: "POST",
      url: "/api/member/portrait/publish",
      headers: { cookie },
      payload: { versionId: secondReady.submittedVersion.id },
    });
    expect(replaced.json()).toMatchObject({
      status: "published",
      publishedVersion: { id: secondReady.submittedVersion.id, version: 2 },
    });

    const withdrawn = await app.inject({
      method: "DELETE",
      url: "/api/member/portrait/publish",
      headers: { cookie },
    });
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json()).toMatchObject({
      status: "ready_to_publish",
      submittedVersion: { version: 2 },
      publishedVersion: null,
    });

    const pool = new Pool({ connectionString: databaseUrl });
    const versions = await pool.query<{ version: number }>(
      "select version from portrait_versions order by version",
    );
    const state = await pool.query<{ published_version_id: string | null }>(
      "select published_version_id from portrait_member_states",
    );
    await pool.end();
    expect(versions.rows.map((version) => version.version)).toEqual([1, 2]);
    expect(state.rows[0]!.published_version_id).toBeNull();
  });
});
