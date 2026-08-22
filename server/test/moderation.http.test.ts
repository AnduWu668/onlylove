import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadRootEnv } from "../src/env.js";
import { MemoryMailer } from "../src/modules/members/mailer.js";

loadRootEnv();
const configuredTestUrl = process.env.TEST_DATABASE_URL;
const testDatabaseUrl = new URL(
  configuredTestUrl ??
    process.env.DATABASE_URL ??
    "postgres://onlylove:onlylove@localhost:5433/onlylove",
);
if (!configuredTestUrl) testDatabaseUrl.pathname = "/onlylove_test";
const databaseUrl = testDatabaseUrl.toString();

describe("Moderation HTTP seam", () => {
  let app: FastifyInstance;
  let mailer: MemoryMailer;
  let now: Date;

  async function seedMember(
    pool: Pool,
    email: string,
    role: "member" | "admin" | "super_admin" = "member",
  ) {
    const memberId = randomUUID();
    const criteriaId = randomUUID();
    const portraitVersionId = randomUUID();
    const token = randomUUID();
    await pool.query(
      `INSERT INTO members
        (id, email, password_hash, role, birth_date, nickname, gender,
         height_cm, city, occupation, created_at)
       VALUES ($1, $2, 'test-password-hash', $3, '1990-01-01', $4, 'female',
               165, '上海', '设计师', $5)`,
      [memberId, email, role, email.split("@")[0], now],
    );
    await pool.query(
      `INSERT INTO sessions
        (id, member_id, token_hash, password_setup_required, created_at, expires_at)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        randomUUID(),
        memberId,
        createHash("sha256").update(token).digest("hex"),
        now,
        new Date(now.getTime() + 30 * 86_400_000),
      ],
    );
    await pool.query(
      `INSERT INTO match_criteria_versions
        (id, member_id, version, desired_gender, acceptable_cities, created_at)
       VALUES ($1, $2, 1, 'male', ARRAY['上海'], $3)`,
      [criteriaId, memberId, now],
    );
    await pool.query(
      `INSERT INTO portrait_versions
        (id, member_id, version, client_request_id, source_draft_schema_version,
         match_profile, persona_context_schema_version, persona_context,
         calibration_schema_version, created_at)
       VALUES ($1, $2, 1, $3, 'portrait-draft-v1', '{}',
               'persona-context-v1', '测试分身上下文',
               'portrait-calibration-v1', $4)`,
      [portraitVersionId, memberId, randomUUID(), now],
    );
    return {
      memberId,
      cookie: `onlylove_session=${token}`,
      criteriaId,
      portraitVersionId,
    };
  }

  async function seedScenario() {
    const pool = new Pool({ connectionString: databaseUrl });
    const reporter = await seedMember(pool, "reporter@onlylove.test");
    const reported = await seedMember(pool, "reported@onlylove.test");
    const outsider = await seedMember(pool, "outsider@onlylove.test");
    const admin = await seedMember(pool, "moderator@onlylove.test", "admin");
    const superAdmin = await seedMember(
      pool,
      "auditor@onlylove.test",
      "super_admin",
    );

    const evaluationJobId = randomUUID();
    const evaluationId = randomUUID();
    const recommendationId = randomUUID();
    const contactRequestId = randomUUID();
    await pool.query(
      `INSERT INTO agent_jobs
        (id, role, task, definition_version, prompt_version, schema_version,
         member_id, status, retry_count, switched_model, quota_refunded,
         created_at, completed_at)
       VALUES ($1, 'match_evaluator', 'evaluate_pair', 'matching-v0',
               'matching-rubric-v0', 'pair-evaluation-schema-v0', $2,
               'completed', 0, false, false, $3, $3)`,
      [evaluationJobId, reporter.memberId, now],
    );
    await pool.query(
      `INSERT INTO pair_evaluations
        (id, member_a_id, member_b_id, portrait_version_a_id,
         portrait_version_b_id, criteria_version_a_id, criteria_version_b_id,
         agent_job_id, rubric_version, result, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               'matching-rubric-v0', '{}', $9)`,
      [
        evaluationId,
        reporter.memberId,
        reported.memberId,
        reporter.portraitVersionId,
        reported.portraitVersionId,
        reporter.criteriaId,
        reported.criteriaId,
        evaluationJobId,
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
        reporter.memberId,
        reported.memberId,
        evaluationId,
        reporter.portraitVersionId,
        reported.portraitVersionId,
        reporter.criteriaId,
        reported.criteriaId,
        now,
      ],
    );
    await pool.query(
      `INSERT INTO contact_requests
        (id, recommendation_id, requester_member_id, recipient_member_id,
         status, created_at, expires_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
      [
        contactRequestId,
        recommendationId,
        reporter.memberId,
        reported.memberId,
        now,
        new Date(now.getTime() + 7 * 86_400_000),
      ],
    );

    const twinConversationId = randomUUID();
    const reporterQuestionId = randomUUID();
    const twinAnswerId = randomUUID();
    await pool.query(
      `INSERT INTO conversations
        (id, type, member_id, visitor_member_id, anonymous_code,
         visibility_consent_at, created_at)
       VALUES ($1, 'TWIN', $2, $3, 'MODERATION01', $4, $4)`,
      [twinConversationId, reported.memberId, reporter.memberId, now],
    );
    await pool.query(
      `INSERT INTO conversation_messages
        (id, conversation_id, role, content, sequence, sender_member_id, created_at)
       VALUES
        ($1, $2, 'member', '你是否一定会留在上海？', 1, $3, $5),
        ($4, $2, 'agent', '我永远不会离开上海。', 2, NULL, $5)`,
      [
        reporterQuestionId,
        twinConversationId,
        reporter.memberId,
        twinAnswerId,
        now,
      ],
    );

    const connectionId = randomUUID();
    const humanConversationId = randomUUID();
    const humanMessageId = randomUUID();
    await pool.query(
      `INSERT INTO member_connections
        (id, member_a_id, member_b_id, status, created_at)
       VALUES ($1, $2, $3, 'active', $4)`,
      [connectionId, reporter.memberId, reported.memberId, now],
    );
    await pool.query(
      `INSERT INTO current_connection_members
        (member_id, connection_id, created_at)
       VALUES ($1, $3, $4), ($2, $3, $4)`,
      [reporter.memberId, reported.memberId, connectionId, now],
    );
    await pool.query(
      `INSERT INTO conversations
        (id, type, member_id, visitor_member_id, connection_id, created_at)
       VALUES ($1, 'HUMAN', $2, $3, $4, $5)`,
      [
        humanConversationId,
        reporter.memberId,
        reported.memberId,
        connectionId,
        now,
      ],
    );
    await pool.query(
      `INSERT INTO conversation_messages
        (id, conversation_id, role, content, sequence, sender_member_id, created_at)
       VALUES ($1, $2, 'member', '这是一条需要审核的真人消息。', 1, $3, $4)`,
      [humanMessageId, humanConversationId, reported.memberId, now],
    );
    await pool.end();
    return {
      admin,
      connectionId,
      contactRequestId,
      humanConversationId,
      humanMessageId,
      outsider,
      reported,
      reporter,
      recommendationId,
      superAdmin,
      twinAnswerId,
      twinConversationId,
    };
  }

  async function reportHumanMessage(
    seeded: Awaited<ReturnType<typeof seedScenario>>,
    block = false,
  ) {
    return app.inject({
      method: "POST",
      url: "/api/member/reports",
      headers: { cookie: seeded.reporter.cookie },
      payload: {
        targetKind: "human_message",
        targetId: seeded.humanMessageId,
        reason: "故意发送伤害性内容",
        evidence: "该消息对我的个人边界造成伤害。",
        block,
      },
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
    if (app) await app.close();
    const pool = new Pool({ connectionString: databaseUrl });
    await pool.query("TRUNCATE sessions, members CASCADE");
    await pool.end();
    now = new Date("2026-08-22T08:00:00.000Z");
    mailer = new MemoryMailer();
    app = await createApp({
      databaseUrl,
      mailer,
      otpSecret: "test-only-secret",
      superAdminEmail: "admin@onlylove.test",
      now: () => now,
    });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("records specific twin-answer feedback as a quality signal without punishment", async () => {
    const seeded = await seedScenario();
    const response = await app.inject({
      method: "POST",
      url: "/api/member/distortion-feedback",
      headers: { cookie: seeded.reporter.cookie },
      payload: {
        messageId: seeded.twinAnswerId,
        details: "这不是主人此前表达过的稳定计划。",
      },
    });

    expect(response.statusCode).toBe(201);

    const ownerState = await app.inject({
      method: "GET",
      url: "/api/member/moderation",
      headers: { cookie: seeded.reported.cookie },
    });
    expect(ownerState.statusCode).toBe(200);
    expect(ownerState.json()).toMatchObject({
      receivedFeedback: [
        {
          message: { id: seeded.twinAnswerId, content: "我永远不会离开上海。" },
          correctionPrompt: expect.stringContaining("理解纠正"),
        },
      ],
      accessRestricted: false,
      receivedDecisions: [],
    });

    const metrics = await app.inject({
      method: "GET",
      url: "/api/admin/moderation-metrics",
      headers: { cookie: seeded.admin.cookie },
    });
    expect(metrics.json()).toMatchObject({ distortionFeedbackCount: 1 });
    const cases = await app.inject({
      method: "GET",
      url: "/api/admin/moderation-cases",
      headers: { cookie: seeded.admin.cookie },
    });
    expect(cases.json().cases).toEqual([]);
  });

  it.each([
    ["recommendation", "recommendationId"],
    ["contact_request", "contactRequestId"],
    ["connection", "connectionId"],
  ] as const)(
    "blocks from the %s stage immediately without creating a report",
    async (targetKind, targetKey) => {
      const seeded = await seedScenario();
      const targetId = seeded[targetKey];
      const response = await app.inject({
        method: "POST",
        url: "/api/member/blocks",
        headers: { cookie: seeded.reporter.cookie },
        payload: { targetKind, targetId },
      });
      expect(response.statusCode).toBe(201);

      const duplicate = await app.inject({
        method: "POST",
        url: "/api/member/blocks",
        headers: { cookie: seeded.reporter.cookie },
        payload: { targetKind, targetId },
      });
      expect(duplicate.statusCode).toBe(200);

      const reporterConnections = await app.inject({
        method: "GET",
        url: "/api/member/contact-requests",
        headers: { cookie: seeded.reporter.cookie },
      });
      expect(reporterConnections.json()).toMatchObject({
        outgoing: [{ id: seeded.contactRequestId, status: "cancelled" }],
        currentConnection: null,
      });
      const reportedConnections = await app.inject({
        method: "GET",
        url: "/api/member/contact-requests",
        headers: { cookie: seeded.reported.cookie },
      });
      expect(reportedConnections.json()).toMatchObject({
        currentConnection: null,
      });
      const cases = await app.inject({
        method: "GET",
        url: "/api/admin/moderation-cases",
        headers: { cookie: seeded.admin.cookie },
      });
      expect(cases.json().cases).toEqual([]);

      const send = await app.inject({
        method: "POST",
        url: `/api/member/human-conversations/${seeded.humanConversationId}/messages`,
        headers: { cookie: seeded.reported.cookie },
        payload: { clientMessageId: randomUUID(), content: "还能发送吗？" },
      });
      expect(send.statusCode).toBe(409);
      expect(send.json()).toEqual({ code: "HUMAN_CONVERSATION_READ_ONLY" });
    },
  );

  it.each([
    ["recommendation", "recommendationId"],
    ["twin_message", "twinAnswerId"],
    ["human_message", "humanMessageId"],
  ] as const)("creates a review case for a %s target", async (targetKind, targetKey) => {
    const seeded = await seedScenario();
    const response = await app.inject({
      method: "POST",
      url: "/api/member/reports",
      headers: { cookie: seeded.reporter.cookie },
      payload: {
        targetKind,
        targetId: seeded[targetKey],
        reason: "故意夸大或造成伤害",
        evidence: "请结合关联上下文复核。",
        block: false,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      case: { targetKind, status: "pending", reason: "故意夸大或造成伤害" },
    });
  });

  it("lets an administrator inspect only chat attached to a report case", async () => {
    const seeded = await seedScenario();
    const reported = await reportHumanMessage(seeded);
    expect(reported.statusCode).toBe(201);
    const caseId = reported.json().case.id as string;

    const forbidden = await app.inject({
      method: "GET",
      url: `/api/admin/moderation-cases/${caseId}`,
      headers: { cookie: seeded.outsider.cookie },
    });
    expect(forbidden.statusCode).toBe(403);

    const detail = await app.inject({
      method: "GET",
      url: `/api/admin/moderation-cases/${caseId}`,
      headers: { cookie: seeded.admin.cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      case: {
        id: caseId,
        status: "pending",
        reason: "故意发送伤害性内容",
      },
      chat: {
        conversationId: seeded.humanConversationId,
        messages: [
          { id: seeded.humanMessageId, content: "这是一条需要审核的真人消息。" },
        ],
      },
    });
    const forbiddenAudit = await app.inject({
      method: "GET",
      url: "/api/admin/moderation-access-audit",
      headers: { cookie: seeded.admin.cookie },
    });
    expect(forbiddenAudit.statusCode).toBe(403);
    const audit = await app.inject({
      method: "GET",
      url: "/api/admin/moderation-access-audit",
      headers: { cookie: seeded.superAdmin.cookie },
    });
    expect(audit.json().audits[0]).toMatchObject({
      caseId,
      actorMemberId: seeded.admin.memberId,
    });
    const invitation = await app.inject({
      method: "POST",
      url: "/api/admin/invitations",
      headers: { cookie: seeded.admin.cookie },
      payload: { email: "new-member@onlylove.test" },
    });
    expect(invitation.statusCode).toBe(201);
  });

  it("resolves each case once, sends disclosure-limited notices, and creates a new appeal case", async () => {
    const seeded = await seedScenario();
    const report = await reportHumanMessage(seeded);
    const caseId = report.json().case.id as string;
    const decision = await app.inject({
      method: "POST",
      url: `/api/admin/moderation-cases/${caseId}/decision`,
      headers: { cookie: seeded.admin.cookie },
      payload: { action: "warning", reason: "消息越过了对方明确边界。" },
    });
    expect(decision.statusCode).toBe(200);
    expect(decision.json()).toMatchObject({
      case: { id: caseId, status: "resolved" },
      decision: { action: "warning", reason: "消息越过了对方明确边界。" },
    });

    const repeated = await app.inject({
      method: "POST",
      url: `/api/admin/moderation-cases/${caseId}/decision`,
      headers: { cookie: seeded.admin.cookie },
      payload: { action: "dismissed", reason: "重复处理" },
    });
    expect(repeated.statusCode).toBe(409);
    expect(mailer.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          to: "reporter@onlylove.test",
          type: "moderation_decision",
          disclosure: "reporter",
        }),
        expect.objectContaining({
          to: "reported@onlylove.test",
          type: "moderation_decision",
          disclosure: "reported",
        }),
      ]),
    );

    const reporterState = await app.inject({
      method: "GET",
      url: "/api/member/moderation",
      headers: { cookie: seeded.reporter.cookie },
    });
    expect(reporterState.json().submittedReports[0]).toMatchObject({
      id: caseId,
      status: "resolved",
      outcome: "processed",
    });
    expect(reporterState.body).not.toContain("warning");
    expect(reporterState.body).not.toContain("消息越过了对方明确边界");

    const reportedState = await app.inject({
      method: "GET",
      url: "/api/member/moderation",
      headers: { cookie: seeded.reported.cookie },
    });
    expect(reportedState.json().receivedDecisions[0]).toMatchObject({
      caseId,
      action: "warning",
      reason: "消息越过了对方明确边界。",
      canAppeal: true,
    });

    const appeal = await app.inject({
      method: "POST",
      url: `/api/member/moderation-cases/${caseId}/appeal`,
      headers: { cookie: seeded.reported.cookie },
      payload: {
        reason: "请求复核上下文。",
        evidence: "原消息是在双方约定的讨论场景中发送。",
      },
    });
    expect(appeal.statusCode).toBe(201);
    expect(appeal.json()).toMatchObject({
      case: { type: "appeal", status: "pending", originalCaseId: caseId },
    });

    const cases = await app.inject({
      method: "GET",
      url: "/api/admin/moderation-cases",
      headers: { cookie: seeded.admin.cookie },
    });
    expect(cases.json().cases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: caseId, status: "resolved" }),
        expect.objectContaining({
          type: "appeal",
          status: "pending",
          originalCaseId: caseId,
        }),
      ]),
    );
  });

  it("enforces a dated suspension immediately but keeps recommendation eligibility blocked after it expires", async () => {
    const seeded = await seedScenario();
    const report = await reportHumanMessage(seeded, true);
    const caseId = report.json().case.id as string;
    const suspendedUntil = new Date(now.getTime() + 7 * 86_400_000);
    const decision = await app.inject({
      method: "POST",
      url: `/api/admin/moderation-cases/${caseId}/decision`,
      headers: { cookie: seeded.admin.cookie },
      payload: {
        action: "suspended",
        reason: "重复越过成员边界。",
        suspendedUntil: suspendedUntil.toISOString(),
      },
    });
    expect(decision.statusCode).toBe(200);

    const profileWhileSuspended = await app.inject({
      method: "GET",
      url: "/api/member/profile",
      headers: { cookie: seeded.reported.cookie },
    });
    expect(profileWhileSuspended.statusCode).toBe(401);
    const moderationWhileSuspended = await app.inject({
      method: "GET",
      url: "/api/member/moderation",
      headers: { cookie: seeded.reported.cookie },
    });
    expect(moderationWhileSuspended.json()).toMatchObject({
      accessRestricted: true,
      suspendedUntil: suspendedUntil.toISOString(),
    });

    now = new Date(suspendedUntil.getTime() + 1);
    const profileAfterSuspension = await app.inject({
      method: "GET",
      url: "/api/member/profile",
      headers: { cookie: seeded.reported.cookie },
    });
    expect(profileAfterSuspension.statusCode).toBe(200);
    const recommendations = await app.inject({
      method: "GET",
      url: "/api/member/recommendations",
      headers: { cookie: seeded.reported.cookie },
    });
    expect(recommendations.statusCode).toBe(200);
    expect(recommendations.json().eligibility.reasons).toContain(
      "moderation_restricted",
    );

    const appeal = await app.inject({
      method: "POST",
      url: `/api/member/moderation-cases/${caseId}/appeal`,
      headers: { cookie: seeded.reported.cookie },
      payload: { reason: "申请恢复推荐资格。", evidence: "补充案件上下文。" },
    });
    const review = await app.inject({
      method: "POST",
      url: `/api/admin/moderation-cases/${appeal.json().case.id}/decision`,
      headers: { cookie: seeded.admin.cookie },
      payload: { action: "dismissed", reason: "复核后撤销原处置。" },
    });
    expect(review.statusCode).toBe(200);
    const recommendationsAfterReview = await app.inject({
      method: "GET",
      url: "/api/member/recommendations",
      headers: { cookie: seeded.reported.cookie },
    });
    expect(recommendationsAfterReview.json().eligibility.reasons).not.toContain(
      "moderation_restricted",
    );
  });

  it("keeps unrelated case punishments when one punishment is appealed", async () => {
    const seeded = await seedScenario();
    const bannedCaseId = (await reportHumanMessage(seeded)).json().case.id as string;
    const suspendedCaseId = (await reportHumanMessage(seeded)).json().case.id as string;
    await app.inject({
      method: "POST",
      url: `/api/admin/moderation-cases/${bannedCaseId}/decision`,
      headers: { cookie: seeded.admin.cookie },
      payload: { action: "banned", reason: "严重且持续越过成员边界。" },
    });
    await app.inject({
      method: "POST",
      url: `/api/admin/moderation-cases/${suspendedCaseId}/decision`,
      headers: { cookie: seeded.admin.cookie },
      payload: {
        action: "suspended",
        reason: "另一起案件需要限期停用。",
        suspendedUntil: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
      },
    });

    const appeal = await app.inject({
      method: "POST",
      url: `/api/member/moderation-cases/${suspendedCaseId}/appeal`,
      headers: { cookie: seeded.reported.cookie },
      payload: { reason: "申请复核限期处置。", evidence: "补充案件上下文。" },
    });
    await app.inject({
      method: "POST",
      url: `/api/admin/moderation-cases/${appeal.json().case.id}/decision`,
      headers: { cookie: seeded.admin.cookie },
      payload: { action: "dismissed", reason: "撤销这一起案件的限期处置。" },
    });

    const profile = await app.inject({
      method: "GET",
      url: "/api/member/profile",
      headers: { cookie: seeded.reported.cookie },
    });
    expect(profile.statusCode).toBe(401);
    const moderation = await app.inject({
      method: "GET",
      url: "/api/member/moderation",
      headers: { cookie: seeded.reported.cookie },
    });
    expect(moderation.json()).toMatchObject({
      accessRestricted: true,
      suspendedUntil: "9999-12-31T23:59:59.999Z",
    });
  });
});
