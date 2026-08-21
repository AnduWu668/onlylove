import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadRootEnv } from "../src/env.js";
import { MemoryMailer } from "../src/modules/members/mailer.js";
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
const DYNAMIC_COLLISION_PROMPT =
  "你已接受本地长期项目，伴侣突然需要在两个月内决定是否去海外定居，你会怎样一起决定？";

describe("portrait submission, calibration, and publication HTTP seam", () => {
  let app: FastifyInstance;
  let mailer: MemoryMailer;
  let worker: Awaited<ReturnType<typeof createPortraitWorker>>;

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
    return {
      adminCookie,
      memberCookie: await signIn(email, "1990-01-01"),
    };
  }

  async function promoteToAdmin(email: string) {
    const pool = new Pool({ connectionString: databaseUrl });
    const result = await pool.query(
      "UPDATE members SET role = 'admin' WHERE email = $1 RETURNING id",
      [email],
    );
    await pool.end();
    return result.rows[0].id as string;
  }

  async function completeFixedInterview(cookie: string) {
    const prompts: string[] = [];
    for (;;) {
      const state = await app.inject({
        method: "GET",
        url: "/api/member/portrait/interview",
        headers: { cookie },
      });
      if (state.json().fixedInterview.completed) return prompts;
      const question = state.json().fixedInterview.question as {
        id: string;
        prompt: string;
        options: { id: string }[];
      };
      prompts.push(question.prompt);
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
    app = await createApp({
      databaseUrl,
      mailer,
      otpSecret: "test-only-secret",
      superAdminEmail: "admin@onlylove.test",
      now: () => new Date("2026-08-21T08:00:00.000Z"),
      agentModel: {
        provider: "deterministic-fake",
        model: "portrait-test-v1",
        reply: DYNAMIC_COLLISION_PROMPT,
        extractReply: JSON.stringify(draft),
      },
    });
    worker = await createPortraitWorker({
      databaseUrl,
      now: () => new Date("2026-08-21T08:00:00.000Z"),
      agentModel: {
        provider: "deterministic-fake",
        model: "portrait-test-v1",
        reply: "你愿意再说一个具体例子吗？",
      },
    });
  });

  afterAll(async () => {
    if (worker) await worker.close();
    if (app) await app.close();
  });

  it("creates one immutable version only after an idempotent manual submission", async () => {
    const { adminCookie, memberCookie: cookie } =
      await inviteAndSignInMember("submit@onlylove.test");
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

    const fixedPrompts = await completeFixedInterview(cookie);
    const payload = {
      clientRequestId: "f6148226-ef5d-496c-9c9e-fe9e9aebac8a",
    };
    const accepted = await app.inject({
      method: "POST",
      url: "/api/member/portrait/versions",
      headers: { cookie },
      payload,
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({
      status: "generating",
      submittedVersion: { version: 1 },
    });
    const overlapping = await app.inject({
      method: "POST",
      url: "/api/member/portrait/versions",
      headers: { cookie },
      payload: {
        clientRequestId: "b6788239-fb93-414c-95b7-3efce5d13e7c",
      },
    });
    expect(overlapping.statusCode).toBe(409);
    expect(overlapping.json()).toEqual({
      code: "PORTRAIT_VERSION_IN_PROGRESS",
    });
    const submitted = await finishPortraitGeneration(cookie);
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toMatchObject({
      status: "calibrating",
      submittedVersion: { version: 1 },
      publishedVersion: null,
      calibration: { answered: 0, total: 10, likeCount: 0 },
    });
    expect(submitted.json().calibration.scenarios).toHaveLength(10);
    expect(
      submitted
        .json()
        .calibration.scenarios.some((scenario: { prompt: string }) =>
          fixedPrompts.includes(scenario.prompt),
        ),
    ).toBe(false);
    expect(
      submitted
        .json()
        .calibration.scenarios.map((scenario: { prompt: string }) => scenario.prompt)
        .join("\n"),
    ).not.toMatch(/\b\d{3,}\s*(?:个月|天|万元)/);
    expect(
      submitted
        .json()
        .calibration.scenarios.some(
          (scenario: { prompt: string }) =>
            scenario.prompt === DYNAMIC_COLLISION_PROMPT,
        ),
    ).toBe(false);
    expect(
      submitted
        .json()
        .calibration.scenarios.filter(
          (scenario: { kind: string }) => scenario.kind === "single",
        ),
    ).toHaveLength(8);
    expect(
      submitted
        .json()
        .calibration.scenarios.filter(
          (scenario: { kind: string }) => scenario.kind === "conflict",
        ),
    ).toHaveLength(2);
    expect(JSON.stringify(submitted.json())).not.toMatch(
      /dimensions|long_term_planning|matchProfile|personaContext|evidenceMessageIds|partnerExpectation/,
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

    const runs = await app.inject({
      method: "GET",
      url: "/api/admin/agent-runs",
      headers: { cookie: adminCookie },
    });
    const twinRuns = runs
      .json()
      .runs.filter((run: { task: string }) => run.task === "reply_as_twin");
    expect(twinRuns).toHaveLength(10);
    expect(
      new Set(
        twinRuns.map(
          (run: { profileVersionId: string }) => run.profileVersionId,
        ),
      ),
    ).toEqual(new Set([submitted.json().submittedVersion.id]));
    expect(
      new Set(
        twinRuns.map(
          (run: { calibrationScenarioId: string }) =>
            run.calibrationScenarioId,
        ),
      ).size,
    ).toBe(10);
  });

  it("fails calibration on fabrication, keeps focused corrections, and rotates scenarios", async () => {
    const { adminCookie, memberCookie: cookie } =
      await inviteAndSignInMember("calibrate@onlylove.test");
    await completeFixedInterview(cookie);
    const accepted = await app.inject({
      method: "POST",
      url: "/api/member/portrait/versions",
      headers: { cookie },
      payload: {
        clientRequestId: "dcb4c812-9230-493b-820d-a2ba4b6871cc",
      },
    });
    expect(accepted.statusCode).toBe(202);
    const first = (await finishPortraitGeneration(cookie)).json();
    const scenarios = first.calibration.scenarios as {
      id: string;
      kind: "single" | "conflict";
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

    const idempotentReplay = await app.inject({
      method: "POST",
      url: "/api/member/portrait/versions",
      headers: { cookie },
      payload: {
        clientRequestId: "dcb4c812-9230-493b-820d-a2ba4b6871cc",
      },
    });
    expect(idempotentReplay.statusCode).toBe(200);
    expect(idempotentReplay.json().submittedVersion.id).toBe(
      first.submittedVersion.id,
    );

    expect(state.correctionFollowup.eventsUrl).toContain("/events");
    const tooSoon = await app.inject({
      method: "POST",
      url: "/api/member/portrait/versions",
      headers: { cookie },
      payload: {
        clientRequestId: "1d7ca863-eab8-44c5-8e40-4f4957080448",
      },
    });
    expect(tooSoon.statusCode).toBe(409);
    expect(tooSoon.json()).toEqual({ code: "PORTRAIT_DRAFT_UPDATING" });
    const correction = await app.inject({
      method: "GET",
      url: state.correctionFollowup.eventsUrl,
      headers: { cookie },
    });
    expect(correction.body).toContain("event: done");
    const runs = await app.inject({
      method: "GET",
      url: "/api/admin/agent-runs",
      headers: { cookie: adminCookie },
    });
    expect(
      runs
        .json()
        .runs.filter((run: { task: string }) => run.task === "extract_portrait"),
    ).toHaveLength(2);

    const finishFailedCalibration = async (current: any) => {
      let failed = current;
      for (const scenario of current.calibration.scenarios) {
        const response = await app.inject({
          method: "POST",
          url: `/api/member/portrait/calibration/${scenario.id}`,
          headers: { cookie },
          payload: {
            rating: "unlike",
            correction: `第 ${scenario.number} 题仍需补充语境`,
            criticalFabrication: false,
          },
        });
        expect(response.statusCode).toBe(200);
        failed = response.json();
      }
      expect(failed.status).toBe("needs_more_understanding");
      const followup = await app.inject({
        method: "GET",
        url: failed.correctionFollowup.eventsUrl,
        headers: { cookie },
      });
      expect(followup.body).toContain("event: done");
    };

    const nextAccepted = await app.inject({
      method: "POST",
      url: "/api/member/portrait/versions",
      headers: { cookie },
      payload: {
        clientRequestId: "1d7ca863-eab8-44c5-8e40-4f4957080448",
      },
    });
    expect(nextAccepted.statusCode).toBe(202);
    const next = await finishPortraitGeneration(cookie);
    expect(next.statusCode).toBe(200);
    expect(next.json().submittedVersion.version).toBe(2);
    expect(
      next
        .json()
        .calibration.scenarios.map((scenario: { kind: string }) => scenario.kind),
    ).toEqual(scenarios.map((scenario) => scenario.kind));
    const nextPrompts = next
      .json()
      .calibration.scenarios.map((scenario: { prompt: string }) => scenario.prompt);
    expect(nextPrompts).not.toEqual(scenarios.map((scenario) => scenario.prompt));
    await finishFailedCalibration(next.json());
    const thirdAccepted = await app.inject({
      method: "POST",
      url: "/api/member/portrait/versions",
      headers: { cookie },
      payload: {
        clientRequestId: "36aa79db-0792-49b9-8129-a326d261f62c",
      },
    });
    expect(thirdAccepted.statusCode).toBe(202);
    const third = await finishPortraitGeneration(cookie);
    const thirdPrompts = third
      .json()
      .calibration.scenarios.map((scenario: { prompt: string }) => scenario.prompt);
    expect(thirdPrompts).not.toEqual(nextPrompts);
    await finishFailedCalibration(third.json());
    const fourthAccepted = await app.inject({
      method: "POST",
      url: "/api/member/portrait/versions",
      headers: { cookie },
      payload: {
        clientRequestId: "16f9c53e-5d52-422e-88a6-8a3d47a417ec",
      },
    });
    expect(fourthAccepted.statusCode).toBe(202);
    const fourth = await finishPortraitGeneration(cookie);
    const fourthPrompts = fourth
      .json()
      .calibration.scenarios.map((scenario: { prompt: string }) => scenario.prompt);
    expect(fourthPrompts).not.toEqual(thirdPrompts);
    await finishFailedCalibration(fourth.json());
    const fifthAccepted = await app.inject({
      method: "POST",
      url: "/api/member/portrait/versions",
      headers: { cookie },
      payload: {
        clientRequestId: "15a14877-dc35-42aa-935f-2573b38f64d2",
      },
    });
    expect(fifthAccepted.statusCode).toBe(202);
    const fifth = await finishPortraitGeneration(cookie);
    const fifthPrompts = fifth.json().calibration.scenarios.map(
      (scenario: { prompt: string }) => scenario.prompt,
    );
    expect(fifthPrompts).not.toEqual(fourthPrompts);
    await finishFailedCalibration(fifth.json());
    const allPrompts = [
      ...scenarios.map((scenario) => scenario.prompt),
      ...nextPrompts,
      ...thirdPrompts,
      ...fourthPrompts,
      ...fifthPrompts,
    ];
    for (let version = 6; version <= 16; version += 1) {
      const accepted = await app.inject({
        method: "POST",
        url: "/api/member/portrait/versions",
        headers: { cookie },
        payload: {
          clientRequestId: `00000000-0000-4000-8000-${String(version).padStart(12, "0")}`,
        },
      });
      expect(accepted.statusCode).toBe(202);
      const current = await finishPortraitGeneration(cookie);
      allPrompts.push(
        ...current
          .json()
          .calibration.scenarios.map(
            (scenario: { prompt: string }) => scenario.prompt,
          ),
      );
      if (version < 16) await finishFailedCalibration(current.json());
    }
    expect(new Set(allPrompts).size).toBe(160);
  });

  it("blocks a new version when the latest calibration correction was not extracted", async () => {
    const { memberCookie: cookie } =
      await inviteAndSignInMember("correction-failure@onlylove.test");
    await completeFixedInterview(cookie);
    await app.inject({
      method: "POST",
      url: "/api/member/portrait/versions",
      headers: { cookie },
      payload: {
        clientRequestId: "60750d4b-8aaa-47bf-a194-02ff47a0a91b",
      },
    });
    const submitted = (await finishPortraitGeneration(cookie)).json();
    let failedCalibration = submitted;
    for (const [index, scenario] of submitted.calibration.scenarios.entries()) {
      const response = await app.inject({
        method: "POST",
        url: `/api/member/portrait/calibration/${scenario.id}`,
        headers: { cookie },
        payload: {
          rating: index < 8 ? "like" : "partial",
          correction: index < 8 ? "" : `第 ${index + 1} 题需要纠正`,
          criticalFabrication: index === 9,
        },
      });
      failedCalibration = response.json();
    }

    await app.close();
    app = await createApp({
      databaseUrl,
      mailer,
      otpSecret: "test-only-secret",
      superAdminEmail: "admin@onlylove.test",
      now: () => new Date("2026-08-21T08:00:00.000Z"),
      agentModel: {
        provider: "deterministic-fake",
        model: "portrait-test-v1",
        error: "extraction unavailable",
      },
    });
    const correction = await app.inject({
      method: "GET",
      url: failedCalibration.correctionFollowup.eventsUrl,
      headers: { cookie },
    });
    expect(correction.body).toContain("event: error");

    const blocked = await app.inject({
      method: "POST",
      url: "/api/member/portrait/versions",
      headers: { cookie },
      payload: {
        clientRequestId: "231ad04d-a41f-4628-94c1-1703e39996a9",
      },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ code: "PORTRAIT_DRAFT_UPDATE_FAILED" });
  });

  it("runs calibration in the worker, records every retry, and stops after three job attempts", async () => {
    const { adminCookie, memberCookie: cookie } =
      await inviteAndSignInMember("worker-failure@onlylove.test");
    await app.inject({
      method: "POST",
      url: "/api/admin/invitations",
      headers: { cookie: adminCookie },
      payload: { email: "operator@onlylove.test" },
    });
    const operatorCookie = await signIn(
      "operator@onlylove.test",
      "1990-01-01",
    );
    const operatorId = await promoteToAdmin("operator@onlylove.test");
    await completeFixedInterview(cookie);
    await worker.close();
    worker = await createPortraitWorker({
      databaseUrl,
      now: () => new Date("2026-08-21T08:00:00.000Z"),
      agentModel: {
        provider: "deterministic-fake",
        model: "portrait-test-v1",
        error: "calibration unavailable",
      },
    });

    const accepted = await app.inject({
      method: "POST",
      url: "/api/member/portrait/versions",
      headers: { cookie },
      payload: {
        clientRequestId: "1666df56-e5ab-4cec-b6b0-e8203f82e05c",
      },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().status).toBe("generating");
    await worker.drain();

    const state = await app.inject({
      method: "GET",
      url: "/api/member/portrait",
      headers: { cookie },
    });
    expect(state.json()).toMatchObject({
      status: "generation_failed",
      message: "分身回答生成失败，请联系管理员重试",
    });
    const unassigned = await app.inject({
      method: "GET",
      url: "/api/admin/agent-jobs/failed",
      headers: { cookie: operatorCookie },
    });
    expect(unassigned.statusCode).toBe(200);
    expect(unassigned.json().jobs).toEqual([]);
    const allFailed = await app.inject({
      method: "GET",
      url: "/api/admin/agent-jobs/failed",
      headers: { cookie: adminCookie },
    });
    expect(allFailed.json().jobs).toHaveLength(10);
    for (const job of allFailed.json().jobs) {
      const assignment = await app.inject({
        method: "POST",
        url: `/api/admin/agent-jobs/${job.id}/assignment`,
        headers: { cookie: adminCookie },
        payload: { adminId: operatorId },
      });
      expect(assignment.statusCode).toBe(200);
    }
    const failed = await app.inject({
      method: "GET",
      url: "/api/admin/agent-jobs/failed",
      headers: { cookie: operatorCookie },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().jobs).toHaveLength(10);
    expect(
      failed.json().jobs.every((job: { retryCount: number }) => job.retryCount === 3),
    ).toBe(true);

    const runs = await app.inject({
      method: "GET",
      url: "/api/admin/agent-runs",
      headers: { cookie: operatorCookie },
    });
    expect(
      runs
        .json()
        .runs.filter((run: { task: string }) => run.task === "reply_as_twin"),
    ).toHaveLength(90);

    const retry = await app.inject({
      method: "POST",
      url: `/api/admin/agent-jobs/${failed.json().jobs[0].id}/retry`,
      headers: { cookie: operatorCookie },
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({ status: "pending" });
  });

  it("publishes only a passing version, atomically replaces it, and withdraws it", async () => {
    const { memberCookie: cookie } =
      await inviteAndSignInMember("publish@onlylove.test");
    await completeFixedInterview(cookie);
    const submit = async (clientRequestId: string) => {
      const accepted = await app.inject({
        method: "POST",
        url: "/api/member/portrait/versions",
        headers: { cookie },
        payload: { clientRequestId },
      });
      expect(accepted.statusCode).toBe(202);
      return finishPortraitGeneration(cookie);
    };
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

    const current = await app.inject({
      method: "GET",
      url: "/api/member/portrait",
      headers: { cookie },
    });
    expect(current.json().publishedVersion).toBeNull();
  });
});
