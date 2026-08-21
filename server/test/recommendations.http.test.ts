import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadRootEnv } from "../src/env.js";
import { MemoryMailer } from "../src/modules/members/mailer.js";
import { PORTRAIT_DIMENSIONS } from "../src/modules/portraits/questions.js";
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

const modelOutput = {
  schemaVersion: "pair-evaluation-schema-v0",
  rubricVersion: "matching-rubric-v0",
  structuredConditionStatus: "pass",
  dimensions: PORTRAIT_DIMENSIONS.map((dimension) => ({
    dimension,
    aToB: 80,
    bToA: 80,
    interactionReason: "双方愿意讨论重要关系议题。",
    hardBoundaryStatus: "pass",
  })),
  safeRecommendationReason: "你们都愿意讨论重要关系议题，可以进一步了解彼此。",
};

describe("Candidate recommendations HTTP seam", () => {
  let app: FastifyInstance;
  let mailer: MemoryMailer;
  let currentTime: Date;
  let worker: Awaited<ReturnType<typeof createPortraitWorker>>;

  async function generate(cookie: string) {
    const accepted = await app.inject({
      method: "POST",
      url: "/api/member/recommendations",
      headers: { cookie },
    });
    expect(accepted.statusCode).toBe(202);
    await worker.drain();
    return app.inject({
      method: "GET",
      url: "/api/member/recommendations",
      headers: { cookie },
    });
  }

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

  async function createMember(
    adminCookie: string,
    profile: {
      email: string;
      nickname: string;
      birthDate: string;
      gender: "female" | "male";
      heightCm: number;
      city: string;
      occupation: string;
      acceptableCities: string[];
    },
  ) {
    await app.inject({
      method: "POST",
      url: "/api/admin/invitations",
      headers: { cookie: adminCookie },
      payload: { email: profile.email },
    });
    const cookie = await signIn(profile.email, profile.birthDate);
    const saved = await app.inject({
      method: "PUT",
      url: "/api/member/profile",
      headers: { cookie },
      payload: {
        profile: {
          nickname: profile.nickname,
          birthDate: profile.birthDate,
          gender: profile.gender,
          heightCm: profile.heightCm,
          city: profile.city,
          occupation: profile.occupation,
        },
        matchCriteria: {
          desiredGender: profile.gender === "female" ? "male" : "female",
          ageMinimum: 25,
          ageMaximum: 45,
          ageMode: "required",
          heightMinimumCm: 150,
          heightMaximumCm: 195,
          heightMode: "required",
          acceptableCities: profile.acceptableCities,
          occupationRequirement: null,
          occupationMode: null,
        },
      },
    });
    expect(saved.statusCode).toBe(200);
    return cookie;
  }

  async function publishEligiblePortrait(
    email: string,
    overrides?: {
      dimension: (typeof PORTRAIT_DIMENSIONS)[number];
      selfTendency?: string | null;
      hardBoundary?: string | null;
    },
  ) {
    const pool = new Pool({ connectionString: databaseUrl });
    const member = await pool.query<{ id: string }>(
      "SELECT id FROM members WHERE email = $1",
      [email],
    );
    const memberId = member.rows[0]!.id;
    const versionId = randomUUID();
    const matchProfile = {
      schemaVersion: "match-profile-v1",
      dimensions: Object.fromEntries(
        PORTRAIT_DIMENSIONS.map((dimension) => [
          dimension,
          {
            selfTendency:
              overrides?.dimension === dimension &&
              overrides.selfTendency !== undefined
                ? overrides.selfTendency
                : "愿意协商",
            partnerExpectation: "愿意协商",
            hardBoundary:
              overrides?.dimension === dimension
                ? (overrides.hardBoundary ?? null)
                : null,
            importance: 1,
            confidence: "high",
            evidenceMessageIds: [],
            contradictions: [],
          },
        ]),
      ),
    };
    await pool.query(
      `INSERT INTO portrait_versions
        (id, member_id, version, client_request_id, source_draft_schema_version,
         match_profile, persona_context_schema_version, persona_context,
         calibration_schema_version, created_at)
       VALUES ($1, $2, 1, $3, 'portrait-draft-v1', $4, 'persona-context-v1',
               '测试分身上下文', 'portrait-calibration-v1', $5)`,
      [versionId, memberId, randomUUID(), matchProfile, new Date()],
    );
    for (let position = 1; position <= 10; position += 1) {
      const scenarioId = randomUUID();
      await pool.query(
        `INSERT INTO portrait_calibration_scenarios
          (id, portrait_version_id, position, dimensions, prompt, prediction, created_at)
         VALUES ($1, $2, $3, $4, '测试场景', '测试回答', $5)`,
        [scenarioId, versionId, position, [PORTRAIT_DIMENSIONS[(position - 1) % 8]], new Date()],
      );
      await pool.query(
        `INSERT INTO portrait_calibration_answers
          (scenario_id, rating, correction, critical_fabrication, created_at)
         VALUES ($1, 'like', '', false, $2)`,
        [scenarioId, new Date()],
      );
    }
    await pool.query(
      `INSERT INTO portrait_member_states
        (member_id, submitted_version_id, published_version_id, updated_at)
       VALUES ($1, $2, $2, $3)`,
      [memberId, versionId, new Date()],
    );
    await pool.end();
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
    if (worker) await worker.close();
    const pool = new Pool({ connectionString: databaseUrl });
    await pool.query(
      "TRUNCATE sessions, otp_challenges, invitations, members CASCADE",
    );
    await pool.end();
    currentTime = new Date("2026-08-22T08:00:00.000Z");
    mailer = new MemoryMailer();
    app = await createApp({
      databaseUrl,
      mailer,
      otpSecret: "test-only-secret",
      superAdminEmail: "admin@onlylove.test",
      now: () => currentTime,
      agentModel: {
        provider: "deterministic-fake",
        model: "matching-v0",
        reply: JSON.stringify(modelOutput),
      },
    });
    worker = await createPortraitWorker({
      databaseUrl,
      now: () => currentTime,
      agentModel: {
        provider: "deterministic-fake",
        model: "matching-v0",
        reply: JSON.stringify(modelOutput),
      },
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (worker) await worker.close();
  });

  it("returns only an eligible, mutually filtered and evaluated candidate card", async () => {
    const adminCookie = await signIn("admin@onlylove.test");
    const memberCookie = await createMember(adminCookie, {
      email: "linxia@onlylove.test",
      nickname: "林夏",
      birthDate: "1992-04-12",
      gender: "female",
      heightCm: 165,
      city: "上海",
      occupation: "产品设计师",
      acceptableCities: ["上海"],
    });
    const candidateCookie = await createMember(adminCookie, {
      email: "beichuan@onlylove.test",
      nickname: "北川",
      birthDate: "1990-03-02",
      gender: "male",
      heightCm: 178,
      city: "上海",
      occupation: "工程师",
      acceptableCities: ["上海"],
    });
    await createMember(adminCookie, {
      email: "other@onlylove.test",
      nickname: "异地成员",
      birthDate: "1991-01-01",
      gender: "male",
      heightCm: 176,
      city: "北京",
      occupation: "编辑",
      acceptableCities: ["上海"],
    });
    await publishEligiblePortrait("linxia@onlylove.test");
    await publishEligiblePortrait("beichuan@onlylove.test");
    await publishEligiblePortrait("other@onlylove.test");

    const response = await generate(memberCookie);

    expect(response.statusCode).toBe(200);
    expect(response.json().candidates).toEqual([
      {
        id: expect.any(String),
        avatarText: "北",
        nickname: "北川",
        age: 36,
        heightCm: 178,
        city: "上海",
        occupation: "工程师",
        reason: "你们都愿意讨论重要关系议题，可以进一步了解彼此。",
      },
    ]);
    const auditPool = new Pool({ connectionString: databaseUrl });
    const audit = await auditPool.query<{
      task: string;
      actual_model: string;
      agent_job_id: string;
    }>(
      `SELECT j.task, r.actual_model, e.agent_job_id
         FROM pair_evaluations e
         JOIN agent_jobs j ON j.id = e.agent_job_id
         JOIN agent_runs r ON r.job_id = j.id
        LIMIT 1`,
    );
    await auditPool.end();
    expect(audit.rows[0]).toMatchObject({
      task: "evaluate_pair",
      actual_model: "matching-v0",
      agent_job_id: expect.any(String),
    });

    await app.inject({
      method: "DELETE",
      url: "/api/member/portrait/publish",
      headers: { cookie: candidateCookie },
    });
    currentTime = new Date("2026-08-23T08:00:00.000Z");
    await createMember(adminCookie, {
      email: "replacement@onlylove.test",
      nickname: "新候选",
      birthDate: "1991-02-01",
      gender: "male",
      heightCm: 177,
      city: "上海",
      occupation: "教师",
      acceptableCities: ["上海"],
    });
    await publishEligiblePortrait("replacement@onlylove.test");
    const replacement = await generate(memberCookie);
    expect(
      replacement.json().candidates.map((candidate: { nickname: string }) => candidate.nickname),
    ).toEqual(["新候选"]);
  });

  it("enforces eligibility, one daily fetch, condition rechecks and versioned skips", async () => {
    const adminCookie = await signIn("admin@onlylove.test");
    const memberCookie = await createMember(adminCookie, {
      email: "member@onlylove.test",
      nickname: "成员甲",
      birthDate: "1992-04-12",
      gender: "female",
      heightCm: 165,
      city: "上海",
      occupation: "产品设计师",
      acceptableCities: ["上海"],
    });
    await createMember(adminCookie, {
      email: "shanghai@onlylove.test",
      nickname: "上海候选",
      birthDate: "1990-03-02",
      gender: "male",
      heightCm: 178,
      city: "上海",
      occupation: "工程师",
      acceptableCities: ["上海"],
    });
    await publishEligiblePortrait("shanghai@onlylove.test");

    const ineligible = await app.inject({
      method: "POST",
      url: "/api/member/recommendations",
      headers: { cookie: memberCookie },
    });
    expect(ineligible.statusCode).toBe(409);
    expect(ineligible.json()).toMatchObject({
      code: "RECOMMENDATION_NOT_ELIGIBLE",
      detail: expect.arrayContaining(["portrait_not_published"]),
    });

    await publishEligiblePortrait("member@onlylove.test");
    const first = await generate(memberCookie);
    expect(first.statusCode).toBe(200);
    expect(first.json().candidates).toHaveLength(1);
    expect(first.json().remainingCapacity).toBe(4);

    const compatibleChange = await app.inject({
      method: "PUT",
      url: "/api/member/profile",
      headers: { cookie: memberCookie },
      payload: {
        profile: {
          nickname: "成员甲",
          birthDate: "1992-04-12",
          gender: "female",
          heightCm: 165,
          city: "上海",
          occupation: "产品设计师",
        },
        matchCriteria: {
          desiredGender: "male",
          ageMinimum: 25,
          ageMaximum: 45,
          ageMode: "required",
          heightMinimumCm: 151,
          heightMaximumCm: 195,
          heightMode: "required",
          acceptableCities: ["上海"],
          occupationRequirement: null,
          occupationMode: null,
        },
      },
    });
    expect(compatibleChange.statusCode).toBe(200);
    const whileRechecking = await app.inject({
      method: "GET",
      url: "/api/member/recommendations",
      headers: { cookie: memberCookie },
    });
    expect(whileRechecking.json().candidates).toEqual([]);
    expect(whileRechecking.json().remainingCapacity).toBe(4);
    await worker.drain();

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/member/recommendations",
      headers: { cookie: memberCookie },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe(
      "RECOMMENDATIONS_ALREADY_REQUESTED_TODAY",
    );

    const changed = await app.inject({
      method: "PUT",
      url: "/api/member/profile",
      headers: { cookie: memberCookie },
      payload: {
        profile: {
          nickname: "成员甲",
          birthDate: "1992-04-12",
          gender: "female",
          heightCm: 165,
          city: "上海",
          occupation: "产品设计师",
        },
        matchCriteria: {
          desiredGender: "male",
          ageMinimum: 25,
          ageMaximum: 45,
          ageMode: "required",
          heightMinimumCm: 150,
          heightMaximumCm: 195,
          heightMode: "required",
          acceptableCities: ["北京"],
          occupationRequirement: null,
          occupationMode: null,
        },
      },
    });
    expect(changed.statusCode).toBe(200);
    const afterChange = await app.inject({
      method: "GET",
      url: "/api/member/recommendations",
      headers: { cookie: memberCookie },
    });
    expect(afterChange.json().candidates).toEqual([]);

    currentTime = new Date("2026-08-23T08:00:00.000Z");
    const beijingCookie = await createMember(adminCookie, {
      email: "beijing@onlylove.test",
      nickname: "北京候选",
      birthDate: "1991-05-01",
      gender: "male",
      heightCm: 176,
      city: "北京",
      occupation: "编辑",
      acceptableCities: ["上海"],
    });
    await publishEligiblePortrait("beijing@onlylove.test");
    const refreshed = await generate(memberCookie);
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().candidates).toHaveLength(1);
    expect(refreshed.json().candidates[0].nickname).toBe("北京候选");

    const recommendationId = refreshed.json().candidates[0].id;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/member/recommendations/${recommendationId}/skip`,
          headers: { cookie: memberCookie },
        })
      ).statusCode,
    ).toBe(204);
    currentTime = new Date("2026-08-24T08:00:00.000Z");
    const afterSkip = await generate(memberCookie);
    expect(afterSkip.statusCode).toBe(200);
    expect(afterSkip.json().candidates).toEqual([]);
    const reverse = await generate(beijingCookie);
    expect(
      reverse.json().candidates.map((candidate: { nickname: string }) => candidate.nickname),
    ).not.toContain("成员甲");
  });

  it("filters blocks and current contacts before invoking pair evaluation", async () => {
    const adminCookie = await signIn("admin@onlylove.test");
    const memberCookie = await createMember(adminCookie, {
      email: "requester@onlylove.test",
      nickname: "发起成员",
      birthDate: "1992-04-12",
      gender: "female",
      heightCm: 165,
      city: "上海",
      occupation: "设计师",
      acceptableCities: ["上海"],
    });
    for (const [email, nickname] of [
      ["blocked@onlylove.test", "已屏蔽成员"],
      ["connected-a@onlylove.test", "已有联系甲"],
      ["connected-b@onlylove.test", "已有联系乙"],
    ]) {
      await createMember(adminCookie, {
        email,
        nickname,
        birthDate: "1990-03-02",
        gender: "male",
        heightCm: 178,
        city: "上海",
        occupation: "工程师",
        acceptableCities: ["上海"],
      });
      await publishEligiblePortrait(email);
    }
    await publishEligiblePortrait("requester@onlylove.test");
    const pool = new Pool({ connectionString: databaseUrl });
    const ids = await pool.query<{ email: string; id: string }>(
      "SELECT email, id FROM members WHERE email = ANY($1)",
      [[
        "requester@onlylove.test",
        "blocked@onlylove.test",
        "connected-a@onlylove.test",
        "connected-b@onlylove.test",
      ]],
    );
    const id = Object.fromEntries(ids.rows.map((row) => [row.email, row.id]));
    await pool.query(
      `INSERT INTO member_blocks (blocker_member_id, blocked_member_id, created_at)
       VALUES ($1, $2, $3)`,
      [id["requester@onlylove.test"], id["blocked@onlylove.test"], currentTime],
    );
    await pool.query(
      `INSERT INTO member_connections (id, member_a_id, member_b_id, status, created_at)
       VALUES ($1, $2, $3, 'active', $4)`,
      [
        randomUUID(),
        id["connected-a@onlylove.test"],
        id["connected-b@onlylove.test"],
        currentTime,
      ],
    );
    await pool.end();

    const response = await generate(memberCookie);
    expect(response.statusCode).toBe(200);
    expect(response.json().candidates).toEqual([]);
  });

  it("withholds an uncertain pair and asks only the missing-information member", async () => {
    await app.close();
    await worker.close();
    const uncertainOutput = {
      ...modelOutput,
      dimensions: modelOutput.dimensions.map((item) =>
        item.dimension === "values"
          ? { ...item, hardBoundaryStatus: "needs_more_information" }
          : item,
      ),
    };
    mailer = new MemoryMailer();
    app = await createApp({
      databaseUrl,
      mailer,
      otpSecret: "test-only-secret",
      superAdminEmail: "admin@onlylove.test",
      now: () => currentTime,
      agentModel: {
        provider: "deterministic-fake",
        model: "matching-v0",
        reply: JSON.stringify(uncertainOutput),
      },
    });
    worker = await createPortraitWorker({
      databaseUrl,
      now: () => currentTime,
      agentModel: {
        provider: "deterministic-fake",
        model: "matching-v0",
        reply: JSON.stringify(uncertainOutput),
      },
    });
    const adminCookie = await signIn("admin@onlylove.test");
    const requesterCookie = await createMember(adminCookie, {
      email: "boundary@onlylove.test",
      nickname: "边界成员",
      birthDate: "1992-04-12",
      gender: "female",
      heightCm: 165,
      city: "上海",
      occupation: "设计师",
      acceptableCities: ["上海"],
    });
    const missingCookie = await createMember(adminCookie, {
      email: "missing@onlylove.test",
      nickname: "待补充成员",
      birthDate: "1990-03-02",
      gender: "male",
      heightCm: 178,
      city: "上海",
      occupation: "工程师",
      acceptableCities: ["上海"],
    });
    await publishEligiblePortrait("boundary@onlylove.test", {
      dimension: "values",
      hardBoundary: "重要价值选择必须坦诚讨论",
    });
    await publishEligiblePortrait("missing@onlylove.test", {
      dimension: "values",
      selfTendency: null,
    });

    const generated = await generate(requesterCookie);
    expect(generated.statusCode).toBe(200);
    expect(generated.json().candidates).toEqual([]);
    const missingState = await app.inject({
      method: "GET",
      url: "/api/member/recommendations",
      headers: { cookie: missingCookie },
    });
    expect(missingState.json().followupQuestions).toHaveLength(1);
    expect(missingState.json().followupQuestions[0].question).toContain(
      "价值选择",
    );
    expect(missingState.json().followupQuestions[0].question).not.toContain(
      "边界成员",
    );
  });

  it("lets only the super administrator configure and audit matching limits", async () => {
    const adminCookie = await signIn("admin@onlylove.test");
    const memberCookie = await createMember(adminCookie, {
      email: "member@onlylove.test",
      nickname: "普通成员",
      birthDate: "1992-04-12",
      gender: "female",
      heightCm: 165,
      city: "上海",
      occupation: "设计师",
      acceptableCities: ["上海"],
    });
    const forbidden = await app.inject({
      method: "PUT",
      url: "/api/admin/matching-settings",
      headers: { cookie: memberCookie },
      payload: { candidateCapacity: 2, minimumReciprocalScore: 75 },
    });
    expect(forbidden.statusCode).toBe(403);

    const updated = await app.inject({
      method: "PUT",
      url: "/api/admin/matching-settings",
      headers: { cookie: adminCookie },
      payload: { candidateCapacity: 2, minimumReciprocalScore: 75 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({
      candidateCapacity: 2,
      minimumReciprocalScore: 75,
    });
    const audit = await app.inject({
      method: "GET",
      url: "/api/admin/matching-settings/audit",
      headers: { cookie: adminCookie },
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().audits[0]).toMatchObject({
      previousCapacity: 5,
      previousMinimumScore: 60,
      candidateCapacity: 2,
      minimumReciprocalScore: 75,
    });
  });
});
