import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadRootEnv } from "../src/env.js";
import { MemoryMailer } from "../src/modules/members/mailer.js";
import { PORTRAIT_DIMENSIONS } from "../src/modules/portraits/questions.js";

loadRootEnv();
const configuredTestUrl = process.env.TEST_DATABASE_URL;
const testDatabaseUrl = new URL(
  configuredTestUrl ??
    process.env.DATABASE_URL ??
    "postgres://onlylove:onlylove@localhost:5433/onlylove",
);
if (!configuredTestUrl) testDatabaseUrl.pathname = "/onlylove_test";
const databaseUrl = testDatabaseUrl.toString();

describe("issue 16 administration HTTP seam", () => {
  let app: FastifyInstance;
  let pool: Pool;
  const now = new Date("2026-08-23T08:00:00.000Z");

  async function seedMember(
    email: string,
    role: "member" | "admin" | "super_admin" = "member",
  ) {
    const id = randomUUID();
    const token = randomUUID();
    await pool.query(
      `INSERT INTO members
        (id, email, password_hash, role, birth_date, nickname, gender, height_cm, city,
         occupation, created_at)
       VALUES ($1, $2, 'test-password-hash', $3, '1990-01-01', $4, 'female', 165, '上海',
               '设计师', $5)`,
      [id, email, role, email.split("@")[0], now],
    );
    await pool.query(
      `INSERT INTO sessions
        (id, member_id, token_hash, password_setup_required, created_at, expires_at)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        randomUUID(),
        id,
        createHash("sha256").update(token).digest("hex"),
        now,
        new Date(now.getTime() + 86_400_000),
      ],
    );
    return { id, cookie: `onlylove_session=${token}` };
  }

  async function seedPassingCalibration(portraitVersionId: string) {
    for (let position = 1; position <= 10; position += 1) {
      const scenarioId = randomUUID();
      await pool.query(
        `INSERT INTO portrait_calibration_scenarios
          (id, portrait_version_id, position, dimensions, prompt, prediction,
           created_at)
         VALUES ($1, $2, $3, ARRAY['values'], '测试场景', '测试回答', $4)`,
        [scenarioId, portraitVersionId, position, now],
      );
      await pool.query(
        `INSERT INTO portrait_calibration_answers
          (scenario_id, rating, correction, critical_fabrication, created_at)
         VALUES ($1, 'like', '', false, $2)`,
        [scenarioId, now],
      );
    }
  }

  function completeMatchProfile() {
    return {
      schemaVersion: "match-profile-v1",
      dimensions: Object.fromEntries(
        PORTRAIT_DIMENSIONS.map((dimension) => [
          dimension,
          {
            selfTendency: "愿意协商",
            partnerExpectation: "愿意协商",
            hardBoundary: null,
            importance: 1,
            confidence: "high",
            evidenceMessageIds: [],
            contradictions: [],
          },
        ]),
      ),
    };
  }

  beforeAll(async () => {
    const migrationApp = await createApp({
      databaseUrl,
      mailer: new MemoryMailer(),
      otpSecret: "test-only-secret",
      superAdminEmail: "bootstrap@onlylove.test",
    });
    await migrationApp.close();
  });

  beforeEach(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query("TRUNCATE sessions, members CASCADE");
    app = await createApp({
      databaseUrl,
      mailer: new MemoryMailer(),
      otpSecret: "test-only-secret",
      superAdminEmail: "bootstrap@onlylove.test",
      now: () => now,
      agentModel: {
        provider: "volcengine-ark",
        apiKey: "test-secret-that-must-not-leak",
        model: "doubao-test-v1",
        backupModel: "doubao-backup-v1",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        pricing: {
          effectiveDate: "2026-08-01",
          inputCostCnyPerMillionTokens: 2,
          outputCostCnyPerMillionTokens: 8,
        },
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
  });

  it("lets only the super administrator create and deactivate administrators", async () => {
    const superAdmin = await seedMember("owner@onlylove.test", "super_admin");
    const ordinaryAdmin = await seedMember("operator@onlylove.test", "admin");

    const forbidden = await app.inject({
      method: "POST",
      url: "/api/admin/administrators",
      headers: { cookie: ordinaryAdmin.cookie },
      payload: { email: "blocked@onlylove.test" },
    });
    expect(forbidden.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/administrators",
      headers: { cookie: superAdmin.cookie },
      payload: { email: "new-admin@onlylove.test" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      email: "new-admin@onlylove.test",
      role: "admin",
      active: true,
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/admin/administrators",
      headers: { cookie: superAdmin.cookie },
    });
    expect(listed.json().administrators).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ email: "new-admin@onlylove.test", active: true }),
      ]),
    );

    const deactivated = await app.inject({
      method: "PATCH",
      url: `/api/admin/administrators/${created.json().id}`,
      headers: { cookie: superAdmin.cookie },
      payload: { active: false },
    });
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json()).toMatchObject({ active: false });

    const audits = await app.inject({
      method: "GET",
      url: "/api/admin/audits",
      headers: { cookie: superAdmin.cookie },
    });
    expect(audits.json().audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "administrator_created" }),
        expect.objectContaining({ action: "administrator_deactivated" }),
      ]),
    );
  });

  it("keeps hidden member data behind an audited member drill-down", async () => {
    const superAdmin = await seedMember("owner@onlylove.test", "super_admin");
    const ordinaryAdmin = await seedMember("operator@onlylove.test", "admin");
    const member = await seedMember("member@onlylove.test");
    const candidate = await seedMember("candidate@onlylove.test");
    const conversationId = randomUUID();
    const evidenceMessageId = randomUUID();
    const criteriaId = randomUUID();
    const candidateCriteriaId = randomUUID();
    const portraitId = randomUUID();
    const candidatePortraitId = randomUUID();
    const jobId = randomUUID();

    await pool.query(
      `INSERT INTO conversations (id, type, member_id, created_at)
       VALUES ($1, 'INTERVIEW', $2, $3)`,
      [conversationId, member.id, now],
    );
    await pool.query(
      `INSERT INTO conversation_messages
        (id, conversation_id, role, content, sequence, sender_member_id, created_at)
       VALUES ($1, $2, 'member', '我需要被认真倾听。', 1, $3, $4)`,
      [evidenceMessageId, conversationId, member.id, now],
    );
    for (const [id, memberId] of [
      [criteriaId, member.id],
      [candidateCriteriaId, candidate.id],
    ]) {
      await pool.query(
        `INSERT INTO match_criteria_versions
          (id, member_id, version, desired_gender, acceptable_cities, created_at)
         VALUES ($1, $2, 1, 'male', ARRAY['上海'], $3)`,
        [id, memberId, now],
      );
    }
    await pool.query(
      `INSERT INTO portrait_versions
        (id, member_id, version, client_request_id, source_draft_schema_version,
         match_profile, persona_context_schema_version, persona_context,
         calibration_schema_version, created_at)
       VALUES
        ($1, $2, 1, $3, 'portrait-draft-v1', $4,
         'persona-context-v1', '成员隐藏分身上下文', 'portrait-calibration-v1', $5),
        ($6, $7, 1, $8, 'portrait-draft-v1', $9,
         'persona-context-v1', '候选隐藏分身上下文', 'portrait-calibration-v1', $5)`,
      [
        portraitId,
        member.id,
        randomUUID(),
        JSON.stringify({
          schemaVersion: "match-profile-v1",
          dimensions: {
            values: {
              selfTendency: "需要被认真倾听",
              evidenceMessageIds: [evidenceMessageId],
            },
          },
        }),
        now,
        candidatePortraitId,
        candidate.id,
        randomUUID(),
        JSON.stringify({ schemaVersion: "match-profile-v1", dimensions: {} }),
      ],
    );
    await pool.query(
      `INSERT INTO agent_jobs
        (id, role, task, definition_version, prompt_version, schema_version,
         member_id, status, retry_count, switched_model, quota_refunded,
         created_at, completed_at)
       VALUES ($1, 'match_evaluator', 'evaluate_pair', 'match-evaluator-v0',
               'match-evaluator-prompt-v0', 'pair-evaluation-schema-v0', $2,
               'completed', 0, false, false, $3, $3)`,
      [jobId, member.id, now],
    );
    await pool.query(
      `INSERT INTO pair_evaluations
        (id, member_a_id, member_b_id, portrait_version_a_id,
         portrait_version_b_id, criteria_version_a_id, criteria_version_b_id,
         agent_job_id, rubric_version, result, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               'matching-rubric-v0', $9, $10)`,
      [
        randomUUID(),
        member.id,
        candidate.id,
        portraitId,
        candidatePortraitId,
        criteriaId,
        candidateCriteriaId,
        jobId,
        JSON.stringify({ reciprocalScore: 78, aToBScore: 80, bToAScore: 76 }),
        now,
      ],
    );

    const forbidden = await app.inject({
      method: "GET",
      url: `/api/admin/members/${member.id}`,
      headers: { cookie: ordinaryAdmin.cookie },
    });
    expect(forbidden.statusCode).toBe(403);

    const detail = await app.inject({
      method: "GET",
      url: `/api/admin/members/${member.id}`,
      headers: { cookie: superAdmin.cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      member: { id: member.id, email: "member@onlylove.test" },
      portrait: {
        matchProfile: {
          dimensions: { values: { selfTendency: "需要被认真倾听" } },
        },
      },
      evidence: [expect.objectContaining({ content: "我需要被认真倾听。" })],
      conversations: [
        expect.objectContaining({
          id: conversationId,
          messages: [expect.objectContaining({ content: "我需要被认真倾听。" })],
        }),
      ],
      pairEvaluations: [
        expect.objectContaining({ result: expect.objectContaining({ reciprocalScore: 78 }) }),
      ],
    });

    const audits = await app.inject({
      method: "GET",
      url: "/api/admin/audits",
      headers: { cookie: superAdmin.cookie },
    });
    expect(audits.json().audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "member_sensitive_viewed",
          targetMemberId: member.id,
        }),
      ]),
    );
  });

  it("surfaces terminal conversation failures and unifies legacy audits", async () => {
    const superAdmin = await seedMember("owner@onlylove.test", "super_admin");
    const member = await seedMember("member@onlylove.test");
    const reported = await seedMember("reported@onlylove.test");
    const conversationId = randomUUID();
    const jobId = randomUUID();
    const caseId = randomUUID();

    await pool.query(
      `INSERT INTO conversations (id, type, member_id, created_at)
       VALUES ($1, 'INTERVIEW', $2, $3)`,
      [conversationId, member.id, now],
    );
    await pool.query(
      `INSERT INTO agent_jobs
        (id, role, task, definition_version, prompt_version, member_id,
         conversation_id, status, retry_count, switched_model, quota_refunded,
         error, created_at, completed_at)
       VALUES ($1, 'portrait_interviewer', 'continue_interview', 'v1', 'p1', $2,
               $3, 'failed', 1, false, false, 'MODEL_REQUEST_FAILED', $4, $4)`,
      [jobId, member.id, conversationId, now],
    );
    await pool.query(
      `INSERT INTO moderation_cases
        (id, type, reporter_member_id, reported_member_id, target_kind,
         target_id, reason, evidence, status, created_at)
       VALUES ($1, 'report', $2, $3, 'connection', $4, '骚扰', '聊天证据',
               'pending', $5)`,
      [caseId, member.id, reported.id, randomUUID(), now],
    );
    await pool.query(
      `INSERT INTO moderation_case_access_audits
        (id, case_id, actor_member_id, created_at)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), caseId, superAdmin.id, now],
    );
    await pool.query(
      `INSERT INTO member_deletion_audits
        (id, actor_member_id, target_member_id, action, created_at)
       VALUES ($1, $2, $3, 'restored', $4)`,
      [randomUUID(), superAdmin.id, member.id, now],
    );

    const failed = await app.inject({
      method: "GET",
      url: "/api/admin/agent-jobs/failed",
      headers: { cookie: superAdmin.cookie },
    });
    expect(failed.json().jobs).toEqual([
      expect.objectContaining({ id: jobId, retryCount: 1 }),
    ]);

    const retry = await app.inject({
      method: "POST",
      url: `/api/admin/agent-jobs/${jobId}/retry`,
      headers: { cookie: superAdmin.cookie },
    });
    expect(retry.statusCode).toBe(202);

    const audits = await app.inject({
      method: "GET",
      url: "/api/admin/audits",
      headers: { cookie: superAdmin.cookie },
    });
    expect(audits.json().audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "moderation_case_accessed",
          details: { caseId },
        }),
        expect.objectContaining({
          action: "member_restored",
          targetMemberId: member.id,
        }),
      ]),
    );
  });

  it("retains completed lifecycle stages after logical deletion", async () => {
    const superAdmin = await seedMember("owner@onlylove.test", "super_admin");
    const member = await seedMember("deleted@onlylove.test");
    await pool.query("UPDATE members SET deleted_at = $1 WHERE id = $2", [
      now,
      member.id,
    ]);
    await pool.query(
      `INSERT INTO match_criteria_versions
        (id, member_id, version, desired_gender, acceptable_cities, created_at)
       VALUES ($1, $2, 1, 'male', ARRAY['上海'], $3)`,
      [randomUUID(), member.id, now],
    );

    const dashboard = await app.inject({
      method: "GET",
      url: "/api/admin/dashboard",
      headers: { cookie: superAdmin.cookie },
    });
    expect(dashboard.json().members).toMatchObject({
      registered: 1,
      profileCompleted: 1,
      structuredCriteriaCompleted: 1,
      recommendationEligible: 0,
    });
  });

  it("excludes members with a current contact from recommendation eligibility", async () => {
    const superAdmin = await seedMember("owner@onlylove.test", "super_admin");
    const member = await seedMember("member@onlylove.test");
    const candidate = await seedMember("candidate@onlylove.test");
    const portraitId = randomUUID();
    const matchProfile = completeMatchProfile();
    await pool.query(
      `INSERT INTO match_criteria_versions
        (id, member_id, version, desired_gender, acceptable_cities, created_at)
       VALUES ($1, $2, 1, 'male', ARRAY['上海'], $3)`,
      [randomUUID(), member.id, now],
    );
    await pool.query(
      `INSERT INTO portrait_versions
        (id, member_id, version, client_request_id, source_draft_schema_version,
         match_profile, persona_context_schema_version, persona_context,
         calibration_schema_version, created_at)
       VALUES ($1, $2, 1, $3, 'portrait-draft-v1', $4,
               'persona-context-v1', '测试分身上下文',
               'portrait-calibration-v1', $5)`,
      [portraitId, member.id, randomUUID(), matchProfile, now],
    );
    await seedPassingCalibration(portraitId);
    await pool.query(
      `INSERT INTO portrait_member_states
        (member_id, submitted_version_id, published_version_id, updated_at)
       VALUES ($1, $2, $2, $3)`,
      [member.id, portraitId, now],
    );
    await pool.query(
      `INSERT INTO member_connections
        (id, member_a_id, member_b_id, status, created_at)
       VALUES ($1, $2, $3, 'active', $4)`,
      [randomUUID(), member.id, candidate.id, now],
    );

    const dashboard = await app.inject({
      method: "GET",
      url: "/api/admin/dashboard",
      headers: { cookie: superAdmin.cookie },
    });
    expect(dashboard.json().members.recommendationEligible).toBe(0);
  });

  it("aggregates lifecycle, quality, token, cost, latency, failure and model data", async () => {
    const superAdmin = await seedMember("owner@onlylove.test", "super_admin");
    const member = await seedMember("member@onlylove.test");
    const candidate = await seedMember("candidate@onlylove.test");
    const portraitId = randomUUID();
    const historicalPortraitId = randomUUID();
    const candidatePortraitId = randomUUID();
    const criteriaId = randomUUID();
    const candidateCriteriaId = randomUUID();
    const jobId = randomUUID();
    const matchingJobId = randomUUID();
    const evaluationId = randomUUID();
    const recommendationId = randomUUID();

    await pool.query(
      `INSERT INTO portrait_drafts
        (member_id, schema_version, planner_version, content,
         completed_dimensions, last_message_sequence, created_at, updated_at)
       VALUES ($1, 'portrait-draft-v1', 'planner-v1', '{}', 8, 1, $2, $2)`,
      [member.id, now],
    );
    await pool.query(
      `INSERT INTO portrait_versions
        (id, member_id, version, client_request_id, source_draft_schema_version,
         match_profile, persona_context_schema_version, persona_context,
         calibration_schema_version, created_at)
       VALUES
        ($1, $2, 1, $3, 'portrait-draft-v1', $4,
         'persona-context-v1', '隐藏上下文', 'portrait-calibration-v1', $5),
        ($6, $7, 1, $8, 'portrait-draft-v1', $9,
         'persona-context-v1', '候选隐藏上下文', 'portrait-calibration-v1', $5)`,
      [
        portraitId,
        member.id,
        randomUUID(),
        completeMatchProfile(),
        now,
        candidatePortraitId,
        candidate.id,
        randomUUID(),
        completeMatchProfile(),
      ],
    );
    await pool.query(
      `INSERT INTO portrait_versions
        (id, member_id, version, client_request_id, source_draft_schema_version,
         match_profile, persona_context_schema_version, persona_context,
         calibration_schema_version, created_at)
       VALUES ($1, $2, 2, $3, 'portrait-draft-v1', $4,
               'persona-context-v1', '历史隐藏上下文',
               'portrait-calibration-v1', $5)`,
      [
        historicalPortraitId,
        member.id,
        randomUUID(),
        completeMatchProfile(),
        now,
      ],
    );
    await seedPassingCalibration(portraitId);
    await seedPassingCalibration(historicalPortraitId);
    await pool.query(
      `INSERT INTO match_criteria_versions
        (id, member_id, version, desired_gender, acceptable_cities, created_at)
       VALUES
        ($1, $2, 1, 'male', ARRAY['上海'], $5),
        ($3, $4, 1, 'female', ARRAY['上海'], $5)`,
      [criteriaId, member.id, candidateCriteriaId, candidate.id, now],
    );
    await pool.query(
      `INSERT INTO portrait_member_states
        (member_id, submitted_version_id, published_version_id, updated_at)
       VALUES ($1, $2, $2, $3)`,
      [member.id, portraitId, now],
    );
    await pool.query(
      `INSERT INTO recommendation_daily_runs
        (member_id, run_date, status, created_at, completed_at)
       VALUES
        ($1, '2026-08-23', 'completed', $3, $3),
        ($2, '2026-08-23', 'completed', $3, $3)`,
      [member.id, candidate.id, now],
    );
    await pool.query(
      `INSERT INTO agent_jobs
        (id, role, task, definition_version, prompt_version, member_id, status,
         retry_count, switched_model, quota_refunded, created_at, completed_at)
       VALUES ($1, 'portrait_interviewer', 'continue_interview',
               'portrait-interviewer-v1', 'portrait-interviewer-prompt-v1', $2,
               'failed', 3, true, true, $3, $3)`,
      [jobId, member.id, now],
    );
    await pool.query(
      `INSERT INTO agent_jobs
        (id, role, task, definition_version, prompt_version, schema_version,
         member_id, status, retry_count, switched_model, quota_refunded,
         created_at, completed_at)
       VALUES ($1, 'match_evaluator', 'evaluate_pair', 'match-evaluator-v0',
               'match-evaluator-prompt-v0', 'pair-evaluation-schema-v0', $2,
               'completed', 0, false, false, $3, $3)`,
      [matchingJobId, member.id, now],
    );
    await pool.query(
      `INSERT INTO pair_evaluations
        (id, member_a_id, member_b_id, portrait_version_a_id,
         portrait_version_b_id, criteria_version_a_id, criteria_version_b_id,
         agent_job_id, rubric_version, result, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               'matching-rubric-v0', '{"reciprocalScore":80}', $9)`,
      [
        evaluationId,
        member.id,
        candidate.id,
        portraitId,
        candidatePortraitId,
        criteriaId,
        candidateCriteriaId,
        matchingJobId,
        now,
      ],
    );
    await pool.query(
      `INSERT INTO candidate_recommendations
        (id, member_id, candidate_member_id, pair_evaluation_id,
         member_portrait_version_id, candidate_portrait_version_id,
         member_criteria_version_id, candidate_criteria_version_id,
         reason, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               '测试推荐理由', 'pending', $9, $9)`,
      [
        recommendationId,
        member.id,
        candidate.id,
        evaluationId,
        portraitId,
        candidatePortraitId,
        criteriaId,
        candidateCriteriaId,
        now,
      ],
    );
    await pool.query(
      `INSERT INTO recommendation_pair_jobs
        (id, member_id, candidate_member_id, run_date, recommendation_id,
         agent_job_id, pair_evaluation_id, member_portrait_version_id,
         candidate_portrait_version_id, member_criteria_version_id,
         candidate_criteria_version_id, input, status, created_at, updated_at)
       VALUES ($1, $2, $3, '2026-08-23', $4, $5, $6, $7, $8, $9, $10,
               '{}', 'completed', $11, $11)`,
      [
        randomUUID(),
        member.id,
        candidate.id,
        recommendationId,
        matchingJobId,
        evaluationId,
        portraitId,
        candidatePortraitId,
        criteriaId,
        candidateCriteriaId,
        now,
      ],
    );
    await pool.query(
      `INSERT INTO candidate_recommendations
        (id, member_id, candidate_member_id, pair_evaluation_id,
         member_portrait_version_id, candidate_portrait_version_id,
         member_criteria_version_id, candidate_criteria_version_id,
         reason, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               '同日其他来源推荐', 'pending', $9, $9)`,
      [
        randomUUID(),
        candidate.id,
        member.id,
        evaluationId,
        candidatePortraitId,
        portraitId,
        candidateCriteriaId,
        criteriaId,
        now,
      ],
    );
    await pool.query(
      `INSERT INTO agent_runs
        (id, job_id, role, task, definition_version, prompt_version, member_id,
         provider, requested_model, actual_model, input_tokens, output_tokens,
         latency_ms, retry_count, switched_model, error,
         estimated_cost_micro_cny, input_cost_cny_per_million_tokens,
         output_cost_cny_per_million_tokens, pricing_effective_date, created_at)
       VALUES ($1, $2, 'portrait_interviewer', 'continue_interview',
               'portrait-interviewer-v1', 'portrait-interviewer-prompt-v1', $3,
               'volcengine-ark', 'doubao-test-v1', 'doubao-backup-v1', 100, 25,
               420, 2, true, 'MODEL_REQUEST_FAILED', 400000, 2, 8,
               '2026-08-01', $4)`,
      [randomUUID(), jobId, member.id, now],
    );

    const dashboard = await app.inject({
      method: "GET",
      url: "/api/admin/dashboard",
      headers: { cookie: superAdmin.cookie },
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json()).toMatchObject({
      members: {
        registered: 2,
        portraitStarted: 1,
        submitted: 1,
        calibrationPassed: 1,
        published: 1,
      },
      recommendations: { requested: 2, generated: 2, noCandidate: 1 },
      quality: {
        calibrationPassRate: expect.any(Number),
        criticalFabrications: 0,
        distortionFeedback: 0,
      },
    });

    const observability = await app.inject({
      method: "GET",
      url: "/api/admin/agent-observability",
      headers: { cookie: superAdmin.cookie },
    });
    expect(observability.statusCode).toBe(200);
    expect(observability.json()).toMatchObject({
      summary: {
        inputTokens: 100,
        outputTokens: 25,
        estimatedCostCny: 0.4,
        averageLatencyMs: 420,
        failures: 1,
        modelSwitches: 1,
      },
      groups: [
        expect.objectContaining({
          date: "2026-08-23",
          role: "portrait_interviewer",
          provider: "volcengine-ark",
          model: "doubao-backup-v1",
        }),
      ],
      disclaimer: expect.stringContaining("供应商最终账单"),
    });

    const runtime = await app.inject({
      method: "GET",
      url: "/api/admin/agent-runtime",
      headers: { cookie: superAdmin.cookie },
    });
    expect(runtime.statusCode).toBe(200);
    expect(runtime.json()).toMatchObject({
      pricing: {
        effectiveDate: "2026-08-01",
        inputCostCnyPerMillionTokens: 2,
        outputCostCnyPerMillionTokens: 8,
      },
      definitions: expect.arrayContaining([
        expect.objectContaining({
          role: "match_evaluator",
          promptVersion: "match-evaluator-prompt-v0",
          systemPrompt: expect.any(String),
        }),
      ]),
      updatePolicy: expect.stringContaining("benchmark"),
    });
    expect(runtime.body).not.toContain("test-secret-that-must-not-leak");

    for (const url of [
      "/api/admin/moderation-access-audit",
      "/api/admin/matching-settings/audit",
      "/api/admin/agent-quota-settings/audit",
    ]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { cookie: superAdmin.cookie },
      });
      expect(response.statusCode, url).toBe(200);
    }
    const audits = await app.inject({
      method: "GET",
      url: "/api/admin/audits",
      headers: { cookie: superAdmin.cookie },
    });
    expect(audits.json().audits.map(({ action }: { action: string }) => action)).toEqual(
      expect.arrayContaining([
        "moderation_audit_viewed",
        "matching_settings_audit_viewed",
        "agent_quota_settings_audit_viewed",
      ]),
    );
  });
});
