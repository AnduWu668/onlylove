import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { loadRootEnv } from "../src/env.js";
import { MemoryMailer } from "../src/modules/members/mailer.js";
import { PORTRAIT_DIMENSIONS } from "../src/modules/portraits/questions.js";
import { createPortraitWorker } from "../src/portrait-worker.js";

type Json = Record<string, any>;

interface PortraitFixture {
  id: string;
  fixedAnswerOptionIds: string[];
  dialogueMessages: { content: string }[];
  gold: { forbiddenClaims: string[] };
}

interface MemberCase {
  email: string;
  nickname: string;
  birthDate: string;
  gender: "female" | "male";
  heightCm: number;
  occupation: string;
  fixture: PortraitFixture;
  corrections: [string, string];
  expectedRefinedTerms: RegExp[];
}

interface HttpLog {
  method: string;
  path: string;
  status: number;
  latencyMs: number;
}

loadRootEnv();

const NOW = new Date("2026-08-22T08:00:00.000Z");
const ADMIN_EMAIL = "admin@onlylove.test";
const PASSWORD = "secure-pass-123";
const httpLog: HttpLog[] = [];
const qualityFailures: string[] = [];
const UUID_PATTERN =
  /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/iu;

function check(condition: unknown, message: string) {
  if (!condition) qualityFailures.push(message);
}

function asJson(value: unknown, context: string): Json {
  assert(value && typeof value === "object" && !Array.isArray(value), context);
  return value as Json;
}

async function loadFixtures() {
  const raw = JSON.parse(
    await readFile(
      new URL("../../evals/portrait-learning-cases.json", import.meta.url),
      "utf8",
    ),
  ) as { cases: PortraitFixture[] };
  return new Map(raw.cases.map((fixture) => [fixture.id, fixture]));
}

function e2eDatabaseUrl(configuredUrl: string) {
  const url = new URL(process.env.TEST_DATABASE_URL ?? configuredUrl);
  if (!process.env.TEST_DATABASE_URL) url.pathname = "/onlylove_e2e";
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (
    !/^[a-z_][a-z0-9_]*$/i.test(databaseName) ||
    !databaseName.endsWith("_e2e")
  ) {
    throw new Error("TEST_DATABASE_URL must name a dedicated *_e2e database");
  }
  return { databaseName, url };
}

async function ensureDatabase(url: URL, databaseName: string) {
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const pool = new Pool({ connectionString: adminUrl.toString() });
  try {
    const exists = await pool.query(
      "select 1 from pg_database where datname = $1",
      [databaseName],
    );
    if (!exists.rowCount) await pool.query(`create database "${databaseName}"`);
  } finally {
    await pool.end();
  }
}

function changedSlots(before: Json, after: Json) {
  const changes: Json[] = [];
  for (const dimension of PORTRAIT_DIMENSIONS) {
    const previous = before.dimensions?.[dimension] ?? {};
    const current = after.dimensions?.[dimension] ?? {};
    for (const field of [
      "selfTendency",
      "partnerExpectation",
      "hardBoundary",
      "importance",
      "confidence",
      "evidenceMessageIds",
      "contradictions",
    ]) {
      if (JSON.stringify(previous[field]) !== JSON.stringify(current[field])) {
        changes.push({
          dimension,
          field,
          before: previous[field] ?? null,
          after: current[field] ?? null,
        });
      }
    }
  }
  return changes;
}

async function main() {
  if (process.env.RUN_ARK_E2E !== "1") {
    throw new Error("Set RUN_ARK_E2E=1 to allow the real Ark E2E test");
  }

  const config = readConfig();
  assert(config.agentModel, "Real Ark configuration is required");
  const { databaseName, url } = e2eDatabaseUrl(config.databaseUrl);
  const databaseUrl = url.toString();
  await ensureDatabase(url, databaseName);

  const migrationApp = await createApp({
    databaseUrl,
    mailer: new MemoryMailer(),
    otpSecret: "onlylove-real-e2e-secret",
    superAdminEmail: ADMIN_EMAIL,
    now: () => NOW,
    agentModel: config.agentModel,
    agentInputTokenBudget: config.agentInputTokenBudget,
  });
  await migrationApp.close();

  const reportPool = new Pool({ connectionString: databaseUrl });
  await reportPool.query(
    "TRUNCATE sessions, otp_challenges, invitations, members CASCADE",
  );

  const mailer = new MemoryMailer();
  const app = await createApp({
    databaseUrl,
    mailer,
    otpSecret: "onlylove-real-e2e-secret",
    superAdminEmail: ADMIN_EMAIL,
    now: () => NOW,
    agentModel: config.agentModel,
    agentInputTokenBudget: config.agentInputTokenBudget,
  });
  const worker = await createPortraitWorker({
    databaseUrl,
    now: () => NOW,
    agentModel: config.agentModel,
    agentInputTokenBudget: config.agentInputTokenBudget,
  });

  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    let adminCookie = "";

    async function api(
      method: string,
      path: string,
      options: {
        cookie?: string;
        body?: unknown;
        expected?: number | number[];
      } = {},
    ) {
      const startedAt = performance.now();
      const response = await fetch(new URL(path, baseUrl), {
        method,
        headers: {
          ...(options.cookie ? { cookie: options.cookie } : {}),
          ...(options.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      const body =
        text && contentType.includes("application/json")
          ? JSON.parse(text)
          : text;
      const entry = {
        method,
        path,
        status: response.status,
        latencyMs: Math.round(performance.now() - startedAt),
      };
      httpLog.push(entry);
      console.info(
        `${entry.method.padEnd(6)} ${entry.path} -> ${entry.status} (${entry.latencyMs}ms)`,
      );
      const expected = Array.isArray(options.expected)
        ? options.expected
        : [options.expected ?? 200];
      assert(
        expected.includes(response.status),
        `${method} ${path}: expected ${expected.join("/")}, got ${response.status}: ${text}`,
      );
      return { body, headers: response.headers };
    }

    async function consumeEvents(path: string, cookie: string, jobId: string) {
      const first = await api("GET", path, { cookie });
      assert.equal(typeof first.body, "string");
      if (/event: done/.test(first.body)) return;
      const code = first.body.match(/"code":"([^"]+)"/)?.[1] ?? "UNKNOWN_SSE_ERROR";
      qualityFailures.push(`${path}: first agent attempt failed with ${code}`);
      assert(adminCookie, "Administrator session is required to retry an agent job");
      await api("POST", `/api/admin/agent-jobs/${jobId}/retry`, {
        cookie: adminCookie,
        expected: 202,
      });
      const retried = await api("GET", path, { cookie });
      assert.equal(typeof retried.body, "string");
      assert.match(retried.body, /event: done/);
    }

    async function signIn(email: string, birthDate?: string) {
      const challenge = await api("POST", "/api/auth/otp", {
        body: { email },
        expected: 202,
      });
      const code = mailer.lastCodeFor(email);
      assert(code, `OTP was not delivered for ${email}`);
      const verified = await api("POST", "/api/auth/verify", {
        body: {
          email,
          challengeId: asJson(challenge.body, "OTP response").challengeId,
          code,
          ...(birthDate ? { birthDate } : {}),
        },
      });
      const cookie = verified.headers.get("set-cookie")?.split(";", 1)[0];
      assert(cookie, `Session cookie was not returned for ${email}`);
      await api("PUT", "/api/auth/password", {
        cookie,
        body: { password: PASSWORD },
      });
      return cookie;
    }

    async function completeFixedInterview(
      member: MemberCase,
      cookie: string,
    ) {
      for (;;) {
        const state = asJson(
          (await api("GET", "/api/member/portrait/interview", { cookie })).body,
          "portrait interview state",
        );
        const fixed = asJson(state.fixedInterview, "fixed interview state");
        if (fixed.completed) return;
        const question = asJson(fixed.question, "fixed interview question");
        const answerId = member.fixture.fixedAnswerOptionIds[fixed.answered];
        assert(answerId, `${member.email}: fixed answer ${fixed.answered} missing`);
        const optionIds = (question.options as Json[]).map((option) => option.id);
        assert(
          optionIds.includes(answerId),
          `${member.email}: option ${answerId} is not offered for ${question.id}`,
        );
        const saved = asJson(
          (
            await api(
              "POST",
              "/api/member/portrait/interview/fixed-answers",
              {
                cookie,
                body: {
                  questionId: question.id,
                  selectedOptionIds: [answerId],
                  noneApplies: false,
                  freeText: "",
                },
              },
            )
          ).body,
          "fixed answer response",
        );
        if (saved.autoFollowup) {
          const followup = asJson(saved.autoFollowup, "auto followup");
          await consumeEvents(followup.eventsUrl, cookie, followup.jobId);
        }
      }
    }

    async function portraitVersion(email: string, version: number) {
      const result = await reportPool.query<{ match_profile: Json }>(
        `SELECT p.match_profile
           FROM portrait_versions p
           JOIN members m ON m.id = p.member_id
          WHERE m.email = $1 AND p.version = $2`,
        [email, version],
      );
      assert.equal(result.rows.length, 1, `${email}: portrait v${version} missing`);
      return result.rows[0]!.match_profile;
    }

    async function submitVersion(cookie: string, version: number) {
      const accepted = asJson(
        (
          await api("POST", "/api/member/portrait/versions", {
            cookie,
            body: { clientRequestId: randomUUID() },
            expected: 202,
          })
        ).body,
        "portrait submission",
      );
      assert.equal(accepted.status, "generating");
      await worker.drain();
      const state = asJson(
        (await api("GET", "/api/member/portrait", { cookie })).body,
        "generated portrait state",
      );
      assert.equal(state.status, "calibrating");
      assert.equal(asJson(state.submittedVersion, "submitted version").version, version);
      const calibration = asJson(state.calibration, "calibration state");
      assert.equal(calibration.total, 10);
      assert.equal((calibration.scenarios as unknown[]).length, 10);
      return state;
    }

    async function calibrate(
      member: MemberCase,
      cookie: string,
      state: Json,
      refine: boolean,
    ) {
      let current = state;
      const scenarios = asJson(state.calibration, "calibration state")
        .scenarios as Json[];
      for (const [index, scenario] of scenarios.entries()) {
        const partial = refine && index >= 8;
        current = asJson(
          (
            await api(
              "POST",
              `/api/member/portrait/calibration/${scenario.id}`,
              {
                cookie,
                body: {
                  rating: partial ? "partial" : "like",
                  correction: partial ? member.corrections[index - 8] : "",
                  criticalFabrication: false,
                },
              },
            )
          ).body,
          "calibration response",
        );
      }
      const calibration = asJson(current.calibration, "completed calibration");
      assert.equal(calibration.answered, 10);
      assert.equal(calibration.canPublish, true);
      assert.equal(calibration.criticalFabrication, false);
      if (current.correctionFollowup) {
        const followup = asJson(current.correctionFollowup, "correction followup");
        await consumeEvents(followup.eventsUrl, cookie, followup.jobId);
      }
      return current;
    }

    async function addDialogue(member: MemberCase, cookie: string) {
      for (const message of member.fixture.dialogueMessages) {
        const accepted = asJson(
          (
            await api("POST", "/api/member/interview/messages", {
              cookie,
              body: {
                clientMessageId: randomUUID(),
                content: message.content,
              },
              expected: 202,
            })
          ).body,
          "interview message response",
        );
        await consumeEvents(accepted.eventsUrl, cookie, accepted.jobId);
      }
    }

    async function buildPublishedPortrait(member: MemberCase, cookie: string) {
      await completeFixedInterview(member, cookie);
      const firstState = await submitVersion(cookie, 1);
      const baseline = await portraitVersion(member.email, 1);
      const firstReady = await calibrate(member, cookie, firstState, true);
      await api("POST", "/api/member/portrait/publish", {
        cookie,
        body: {
          versionId: asJson(firstReady.submittedVersion, "baseline version").id,
        },
      });
      await addDialogue(member, cookie);
      const secondState = await submitVersion(cookie, 2);
      const refined = await portraitVersion(member.email, 2);
      const ready = await calibrate(member, cookie, secondState, false);
      const versionId = asJson(ready.submittedVersion, "ready version").id;
      const published = asJson(
        (
          await api("POST", "/api/member/portrait/publish", {
            cookie,
            body: { versionId },
          })
        ).body,
        "published portrait",
      );
      assert.equal(published.status, "published");
      assert.equal(
        asJson(published.publishedVersion, "published version").version,
        2,
      );
      return { baseline, refined, changes: changedSlots(baseline, refined) };
    }

    const fixtures = await loadFixtures();
    const fixture = (id: string) => {
      const value = fixtures.get(id);
      assert(value, `Missing portrait fixture ${id}`);
      return value;
    };
    const members: MemberCase[] = [
      {
        email: "planner@onlylove.test",
        nickname: "共同规划者",
        birthDate: "1992-04-12",
        gender: "female",
        heightCm: 165,
        occupation: "产品设计师",
        fixture: fixture("deliberate-planner"),
        corrections: [
          "涉及共同生活时必须共同讨论，我不能接受一方替两个人拍板。",
          "共同资金的大额支出必须双方同意，也不接受查手机或持续共享实时位置。",
        ],
        expectedRefinedTerms: [/共同|一起/, /单方|拍板/, /手机|实时位置/, /预算|大额支出/],
      },
      {
        email: "caregiver@onlylove.test",
        nickname: "实际照顾者",
        birthDate: "1990-03-02",
        gender: "male",
        heightCm: 178,
        occupation: "工程师",
        fixture: fixture("practical-caregiver"),
        corrections: [
          "我可能先申请机会，但接受前一定会和伴侣讨论，不会单方面决定共同生活。",
          "共同预算必须透明，我不能接受瞒着伴侣为亲属借债。",
        ],
        expectedRefinedTerms: [/接受前/, /四十八小时|48小时/, /预算.*透明|透明.*预算/, /瞒.*借债|借债/],
      },
      {
        email: "space@onlylove.test",
        nickname: "空间确认者",
        birthDate: "1991-01-01",
        gender: "male",
        heightCm: 176,
        occupation: "编辑",
        fixture: fixture("space-with-reassurance"),
        corrections: [
          "我需要一晚独处来冷静，但第二天会回应，这不是无限期回避。",
          "不能接受连续两天不回应；临时在外过夜要提前发消息。",
        ],
        expectedRefinedTerms: [/一晚|独处/, /第二天/, /两天|48小时/, /过夜.*提前|提前.*消息/],
      },
    ];

    await api("GET", "/api/health");
    adminCookie = await signIn(ADMIN_EMAIL);
    await api("PUT", "/api/admin/matching-settings", {
      cookie: adminCookie,
      body: { candidateCapacity: 5, minimumReciprocalScore: 0 },
    });

    const cookies = new Map<string, string>();
    for (const member of members) {
      await api("POST", "/api/admin/invitations", {
        cookie: adminCookie,
        body: { email: member.email },
        expected: 201,
      });
      const cookie = await signIn(member.email, member.birthDate);
      cookies.set(member.email, cookie);
      await api("PUT", "/api/member/profile", {
        cookie,
        body: {
          profile: {
            nickname: member.nickname,
            birthDate: member.birthDate,
            gender: member.gender,
            heightCm: member.heightCm,
            city: "上海",
            occupation: member.occupation,
          },
          matchCriteria: {
            desiredGender: member.gender === "female" ? "male" : "female",
            ageMinimum: 25,
            ageMaximum: 45,
            ageMode: "required",
            heightMinimumCm: 150,
            heightMaximumCm: 195,
            heightMode: "required",
            acceptableCities: ["上海"],
            occupationRequirement: null,
            occupationMode: null,
          },
        },
      });
    }

    const portraits: Record<string, Json> = {};
    for (const member of members) {
      console.info(`\n=== Building ${member.email} ===`);
      const result = await buildPublishedPortrait(
        member,
        cookies.get(member.email)!,
      );
      portraits[member.email] = result;
      const refinedText = JSON.stringify(result.refined);
      check(result.changes.length > 0, `${member.email}: v2 did not refine any slot`);
      for (const term of member.expectedRefinedTerms) {
        check(term.test(refinedText), `${member.email}: refined portrait missed ${term}`);
      }
      for (const forbidden of member.fixture.gold.forbiddenClaims) {
        check(
          !refinedText.includes(forbidden),
          `${member.email}: refined portrait fabricated ${forbidden}`,
        );
      }
    }

    const messageIds = new Set(
      (
        await reportPool.query<{ id: string }>(
          "SELECT id FROM conversation_messages",
        )
      ).rows.map(({ id }) => id),
    );
    for (const member of members) {
      for (const [version, profile] of [
        ["baseline", portraits[member.email]!.baseline as Json],
        ["refined", portraits[member.email]!.refined as Json],
      ] as const) {
        check(
          PORTRAIT_DIMENSIONS.every(
            (dimension) => profile.dimensions?.[dimension],
          ),
          `${member.email}: ${version} portrait does not contain all eight dimensions`,
        );
        for (const dimension of PORTRAIT_DIMENSIONS) {
          const slot = profile.dimensions?.[dimension] as Json | undefined;
          for (const field of [
            "selfTendency",
            "partnerExpectation",
            "hardBoundary",
            "contradictions",
          ]) {
            const values = Array.isArray(slot?.[field])
              ? slot[field]
              : [slot?.[field]];
            for (const value of values) {
              check(
                typeof value !== "string" || !UUID_PATTERN.test(value),
                `${member.email}/${version}/${dimension}/${field}: contains an inline message id`,
              );
            }
          }
          for (const evidenceId of slot?.evidenceMessageIds ?? []) {
            check(
              messageIds.has(evidenceId),
              `${member.email}/${version}/${dimension}: unknown evidence ${evidenceId}`,
            );
          }
        }
      }
    }

    const plannerCookie = cookies.get("planner@onlylove.test")!;
    await api("POST", "/api/member/recommendations", {
      cookie: plannerCookie,
      expected: 202,
    });
    await worker.drain();
    const recommendationState = asJson(
      (
        await api("GET", "/api/member/recommendations", {
          cookie: plannerCookie,
        })
      ).body,
      "recommendation state",
    );
    check(recommendationState.generating === false, "recommendations are still generating");
    const candidateNicknames = (recommendationState.candidates as Json[]).map(
      ({ nickname }) => nickname,
    );
    check(candidateNicknames.includes("实际照顾者"), "caregiver candidate was not returned");
    check(candidateNicknames.includes("空间确认者"), "space candidate was not returned");
    for (const candidate of recommendationState.candidates as Json[]) {
      check(
        !/\d+\s*%|aToB|bToA|置信度|权重|evidence/i.test(candidate.reason),
        `${candidate.nickname}: public reason leaked internal matching data`,
      );
    }

    const evaluations = (
      await reportPool.query<{
        member_a: string;
        member_b: string;
        result: Json;
        provider: string;
        requested_model: string;
        actual_model: string;
        input_tokens: number;
        output_tokens: number;
        latency_ms: number;
        estimated_cost_micro_cny: number;
      }>(
        `SELECT a.email AS member_a, b.email AS member_b, e.result,
                r.provider, r.requested_model, r.actual_model,
                r.input_tokens, r.output_tokens, r.latency_ms,
                r.estimated_cost_micro_cny
           FROM pair_evaluations e
           JOIN members a ON a.id = e.member_a_id
           JOIN members b ON b.id = e.member_b_id
           JOIN LATERAL (
             SELECT * FROM agent_runs
              WHERE job_id = e.agent_job_id
              ORDER BY created_at DESC LIMIT 1
           ) r ON true
          WHERE a.email = $1
          ORDER BY b.email`,
        ["planner@onlylove.test"],
      )
    ).rows;
    check(evaluations.length === 2, `expected 2 pair evaluations, got ${evaluations.length}`);
    for (const evaluation of evaluations) {
      check(evaluation.provider === "volcengine-ark", `${evaluation.member_b}: wrong provider`);
      check(
        evaluation.actual_model === config.agentModel.model,
        `${evaluation.member_b}: expected ${config.agentModel.model}, got ${evaluation.actual_model}`,
      );
      check(
        evaluation.result.dimensions?.length === 8,
        `${evaluation.member_b}: pair result does not contain eight dimensions`,
      );
    }
    const caregiver = evaluations.find(
      ({ member_b }) => member_b === "caregiver@onlylove.test",
    );
    const space = evaluations.find(
      ({ member_b }) => member_b === "space@onlylove.test",
    );
    check(caregiver?.result.eligibility === "eligible", "planner/caregiver is not eligible");
    check(space?.result.eligibility === "eligible", "planner/space is not eligible");
    check(
      Number(caregiver?.result.reciprocalScore) >
        Number(space?.result.reciprocalScore),
      "human gold failed: caregiver should rank above space",
    );

    const modelAudit = (
      await reportPool.query<{
        calls: string;
        input_tokens: string;
        output_tokens: string;
        latency_ms: string;
        estimated_cost_micro_cny: string;
        models: string[];
      }>(
        `SELECT COUNT(*)::text AS calls,
                COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
                COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
                COALESCE(SUM(latency_ms), 0)::text AS latency_ms,
                COALESCE(SUM(estimated_cost_micro_cny), 0)::text AS estimated_cost_micro_cny,
                ARRAY_AGG(DISTINCT actual_model) AS models
           FROM agent_runs`,
      )
    ).rows[0]!;

    const report = {
      database: databaseName,
      requests: httpLog,
      portraits,
      recommendations: recommendationState,
      pairEvaluations: evaluations,
      modelAudit,
      qualityFailures,
    };
    console.info("\n=== E2E REPORT ===");
    console.info(JSON.stringify(report, null, 2));
    if (qualityFailures.length) {
      throw new Error(`E2E quality checks failed:\n- ${qualityFailures.join("\n- ")}`);
    }
    console.info("\nPASS real Ark portrait refinement and matching E2E");
  } finally {
    await worker.close();
    await app.close();
    await reportPool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
