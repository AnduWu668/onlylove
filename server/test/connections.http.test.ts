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

describe("Contact requests HTTP seam", () => {
  let app: FastifyInstance;
  let mailer: MemoryMailer;
  let now: Date;

  async function seedMember(
    pool: Pool,
    input: {
      email: string;
      nickname: string;
      birthDate: string;
      gender: "female" | "male";
    },
  ) {
    const memberId = randomUUID();
    const criteriaId = randomUUID();
    const portraitVersionId = randomUUID();
    const token = randomUUID();
    await pool.query(
      `INSERT INTO members
        (id, email, password_hash, role, birth_date, nickname, gender,
         height_cm, city, occupation, created_at)
       VALUES ($1, $2, 'test-password-hash', 'member', $3, $4, $5,
               $6, '上海', $7, $8)`,
      [
        memberId,
        input.email,
        input.birthDate,
        input.nickname,
        input.gender,
        input.gender === "female" ? 165 : 178,
        input.gender === "female" ? "设计师" : "工程师",
        now,
      ],
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
       VALUES ($1, $2, 1, $3, ARRAY['上海'], $4)`,
      [
        criteriaId,
        memberId,
        input.gender === "female" ? "male" : "female",
        now,
      ],
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
    await pool.query(
      `INSERT INTO portrait_member_states
        (member_id, submitted_version_id, published_version_id, updated_at)
       VALUES ($1, $2, $2, $3)`,
      [memberId, portraitVersionId, now],
    );
    return {
      cookie: `onlylove_session=${token}`,
      criteriaId,
      memberId,
      portraitVersionId,
    };
  }

  async function seedCandidateRelationship(
    pool: Pool,
    requester: Awaited<ReturnType<typeof seedMember>>,
    recipient: Awaited<ReturnType<typeof seedMember>>,
    anonymousCode: string,
  ) {
    const evaluationId = randomUUID();
    const evaluationJobId = randomUUID();
    const recommendationId = randomUUID();
    const conversationId = randomUUID();
    await pool.query(
      `INSERT INTO agent_jobs
        (id, role, task, definition_version, prompt_version, schema_version,
         member_id, status, retry_count, switched_model, quota_refunded,
         created_at, completed_at)
       VALUES ($1, 'match_evaluator', 'evaluate_pair', 'matching-v0',
               'matching-rubric-v0', 'pair-evaluation-schema-v0', $2,
               'completed', 0, false, false, $3, $3)`,
      [evaluationJobId, requester.memberId, now],
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
        requester.memberId,
        recipient.memberId,
        requester.portraitVersionId,
        recipient.portraitVersionId,
        requester.criteriaId,
        recipient.criteriaId,
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
               '你们都愿意认真讨论长期关系。', 'pending', $9, $9)`,
      [
        recommendationId,
        requester.memberId,
        recipient.memberId,
        evaluationId,
        requester.portraitVersionId,
        recipient.portraitVersionId,
        requester.criteriaId,
        recipient.criteriaId,
        now,
      ],
    );
    await pool.query(
      `INSERT INTO conversations
        (id, type, member_id, visitor_member_id, recommendation_id,
         anonymous_code, visibility_consent_at, profile_version_id, created_at)
       VALUES ($1, 'TWIN', $2, $3, $4, $5, $6, $7, $6)`,
      [
        conversationId,
        recipient.memberId,
        requester.memberId,
        recommendationId,
        anonymousCode,
        now,
        recipient.portraitVersionId,
      ],
    );
    await pool.query(
      `INSERT INTO conversation_messages
        (id, conversation_id, role, content, sequence, client_message_id, created_at)
       VALUES ($1, $2, 'member', '你如何面对长期计划变化？', 1, $3, $4)`,
      [randomUUID(), conversationId, randomUUID(), now],
    );
    return { conversationId, recommendationId };
  }

  async function seedCandidateConversation() {
    const pool = new Pool({ connectionString: databaseUrl });
    const requester = await seedMember(pool, {
      email: "requester@onlylove.test",
      nickname: "林夏",
      birthDate: "1992-04-12",
      gender: "female",
    });
    const recipient = await seedMember(pool, {
      email: "recipient@onlylove.test",
      nickname: "北川",
      birthDate: "1990-03-02",
      gender: "male",
    });
    const relationship = await seedCandidateRelationship(
      pool,
      requester,
      recipient,
      "ANON00000001",
    );
    await pool.end();
    return { ...relationship, recipient, requester };
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

  it("creates one request after a twin message and discloses only the safe card", async () => {
    const seeded = await seedCandidateConversation();
    const first = await app.inject({
      method: "POST",
      url: `/api/member/recommendations/${seeded.recommendationId}/contact-request`,
      headers: { cookie: seeded.requester.cookie },
    });
    expect(first.statusCode).toBe(201);

    const retried = await app.inject({
      method: "POST",
      url: `/api/member/recommendations/${seeded.recommendationId}/contact-request`,
      headers: { cookie: seeded.requester.cookie },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().id).toBe(first.json().id);

    const inbox = await app.inject({
      method: "GET",
      url: "/api/member/contact-requests",
      headers: { cookie: seeded.recipient.cookie },
    });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().incoming).toEqual([
      expect.objectContaining({
        id: first.json().id,
        status: "pending",
        conversation: {
          id: seeded.conversationId,
          anonymousCode: "ANON00000001",
        },
        candidate: {
          avatarText: "林",
          nickname: "林夏",
          age: 34,
          heightCm: 165,
          city: "上海",
          occupation: "设计师",
          reason: "你们都愿意认真讨论长期关系。",
        },
      }),
    ]);
    expect(JSON.stringify(inbox.json())).not.toMatch(
      /email|matchProfile|reciprocalScore|pairEvaluation/i,
    );
    expect(
      (mailer as MemoryMailer & { notifications: unknown[] }).notifications,
    ).toHaveLength(1);
  });

  it("lets only the recipient win one concurrent acceptance and makes retries idempotent", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const recipient = await seedMember(pool, {
      email: "recipient@onlylove.test",
      nickname: "北川",
      birthDate: "1990-03-02",
      gender: "male",
    });
    const firstRequester = await seedMember(pool, {
      email: "first@onlylove.test",
      nickname: "林夏",
      birthDate: "1992-04-12",
      gender: "female",
    });
    const secondRequester = await seedMember(pool, {
      email: "second@onlylove.test",
      nickname: "清禾",
      birthDate: "1993-05-18",
      gender: "female",
    });
    const firstRelationship = await seedCandidateRelationship(
      pool,
      firstRequester,
      recipient,
      "ANON00000001",
    );
    const secondRelationship = await seedCandidateRelationship(
      pool,
      secondRequester,
      recipient,
      "ANON00000002",
    );
    await pool.end();

    const created = await Promise.all(
      [firstRelationship, secondRelationship].map((relationship, index) =>
        app.inject({
          method: "POST",
          url: `/api/member/recommendations/${relationship.recommendationId}/contact-request`,
          headers: {
            cookie: index === 0 ? firstRequester.cookie : secondRequester.cookie,
          },
        }),
      ),
    );
    expect(created.map(({ statusCode }) => statusCode)).toEqual([201, 201]);

    const requesterCannotAccept = await app.inject({
      method: "POST",
      url: `/api/member/contact-requests/${created[0]!.json().id}/accept`,
      headers: { cookie: firstRequester.cookie },
    });
    expect(requesterCannotAccept.statusCode).toBe(403);

    const accepted = await Promise.all(
      created.map((request) =>
        app.inject({
          method: "POST",
          url: `/api/member/contact-requests/${request.json().id}/accept`,
          headers: { cookie: recipient.cookie },
        }),
      ),
    );
    expect(accepted.map(({ statusCode }) => statusCode).sort()).toEqual([
      200, 409,
    ]);
    const winner = accepted.find((response) => response.statusCode === 200)!;
    const winningIndex = accepted.indexOf(winner);
    const retried = await app.inject({
      method: "POST",
      url: `/api/member/contact-requests/${created[winningIndex]!.json().id}/accept`,
      headers: { cookie: recipient.cookie },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().connection.id).toBe(winner.json().connection.id);

    const state = await app.inject({
      method: "GET",
      url: "/api/member/contact-requests",
      headers: { cookie: recipient.cookie },
    });
    expect(state.json().currentConnection.id).toBe(winner.json().connection.id);
    expect(state.json().incoming.map(({ status }: { status: string }) => status).sort()).toEqual([
      "accepted",
      "cancelled",
    ]);
    expect(
      state.json().incoming.find(
        ({ status }: { status: string }) => status === "cancelled",
      ).resolutionMessage,
    ).toBe("你或对方已建立其他联系，此请求已由系统取消。");

    const auditPool = new Pool({ connectionString: databaseUrl });
    const counts = await auditPool.query<{
      connections: string;
      memberships: string;
    }>(
      `SELECT
        (SELECT COUNT(*)::text FROM member_connections WHERE status = 'active') AS connections,
        (SELECT COUNT(*)::text FROM current_connection_members) AS memberships`,
    );
    await auditPool.end();
    expect(counts.rows[0]).toEqual({ connections: "1", memberships: "2" });
    expect(
      mailer.notifications.filter(({ type }) => type === "contact_accepted"),
    ).toHaveLength(2);
  });

  it("lets the recipient talk to the requester's twin before deciding", async () => {
    const seeded = await seedCandidateConversation();
    const created = await app.inject({
      method: "POST",
      url: `/api/member/recommendations/${seeded.recommendationId}/contact-request`,
      headers: { cookie: seeded.requester.cookie },
    });
    const requestId = created.json().id;

    const requesterCannotOpen = await app.inject({
      method: "POST",
      url: `/api/member/contact-requests/${requestId}/twin-conversation`,
      headers: { cookie: seeded.requester.cookie },
      payload: { consentToOwnerVisibility: true },
    });
    expect(requesterCannotOpen.statusCode).toBe(404);

    const opened = await app.inject({
      method: "POST",
      url: `/api/member/contact-requests/${requestId}/twin-conversation`,
      headers: { cookie: seeded.recipient.cookie },
      payload: { consentToOwnerVisibility: true },
    });
    expect(opened.statusCode).toBe(201);
    expect(opened.json()).toMatchObject({
      canReply: true,
      candidate: {
        nickname: "林夏",
        heightCm: 165,
        city: "上海",
        occupation: "设计师",
      },
    });

    const sent = await app.inject({
      method: "POST",
      url: `/api/member/candidate-twin-conversations/${opened.json().conversationId}/messages`,
      headers: { cookie: seeded.recipient.cookie },
      payload: {
        clientMessageId: randomUUID(),
        content: "你会怎样安排两个人的长期生活计划？",
      },
    });
    expect(sent.statusCode).toBe(202);
  });

  it("distinguishes an idempotent rejection from a seven-day expiry", async () => {
    const rejectedSeed = await seedCandidateConversation();
    const created = await app.inject({
      method: "POST",
      url: `/api/member/recommendations/${rejectedSeed.recommendationId}/contact-request`,
      headers: { cookie: rejectedSeed.requester.cookie },
    });
    const requestId = created.json().id;

    const requesterCannotReject = await app.inject({
      method: "POST",
      url: `/api/member/contact-requests/${requestId}/reject`,
      headers: { cookie: rejectedSeed.requester.cookie },
    });
    expect(requesterCannotReject.statusCode).toBe(403);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const rejected = await app.inject({
        method: "POST",
        url: `/api/member/contact-requests/${requestId}/reject`,
        headers: { cookie: rejectedSeed.recipient.cookie },
      });
      expect(rejected.statusCode).toBe(200);
      expect(rejected.json().status).toBe("rejected");
    }
    const rejectedAccept = await app.inject({
      method: "POST",
      url: `/api/member/contact-requests/${requestId}/accept`,
      headers: { cookie: rejectedSeed.recipient.cookie },
    });
    expect(rejectedAccept.statusCode).toBe(409);

    const pool = new Pool({ connectionString: databaseUrl });
    await pool.query("TRUNCATE sessions, members CASCADE");
    await pool.end();
    const expiringSeed = await seedCandidateConversation();
    const expiring = await app.inject({
      method: "POST",
      url: `/api/member/recommendations/${expiringSeed.recommendationId}/contact-request`,
      headers: { cookie: expiringSeed.requester.cookie },
    });
    now = new Date(now.getTime() + 7 * 24 * 60 * 60_000);
    const expiredState = await app.inject({
      method: "GET",
      url: "/api/member/contact-requests",
      headers: { cookie: expiringSeed.recipient.cookie },
    });
    expect(expiredState.json().incoming[0]).toMatchObject({
      id: expiring.json().id,
      status: "expired",
      resolutionMessage: "请求已过期，不计为拒绝。",
    });
    const expiredAccept = await app.inject({
      method: "POST",
      url: `/api/member/contact-requests/${expiring.json().id}/accept`,
      headers: { cookie: expiringSeed.recipient.cookie },
    });
    expect(expiredAccept.statusCode).toBe(409);
    const auditPool = new Pool({ connectionString: databaseUrl });
    const recommendation = await auditPool.query<{ status: string }>(
      "SELECT status FROM candidate_recommendations WHERE id = $1",
      [expiringSeed.recommendationId],
    );
    const connections = await auditPool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM member_connections WHERE status = 'active'",
    );
    await auditPool.end();
    expect(recommendation.rows[0]!.status).toBe("requested");
    expect(connections.rows[0]!.count).toBe("0");
  });

  it("rechecks blocked, unavailable, unpublished, and already connected members", async () => {
    const scenarios = [
      async (pool: Pool, seeded: Awaited<ReturnType<typeof seedCandidateConversation>>) =>
        pool.query(
          `INSERT INTO member_blocks
            (blocker_member_id, blocked_member_id, created_at)
           VALUES ($1, $2, $3)`,
          [seeded.recipient.memberId, seeded.requester.memberId, now],
        ),
      async (pool: Pool, seeded: Awaited<ReturnType<typeof seedCandidateConversation>>) =>
        pool.query("UPDATE members SET deleted_at = $2 WHERE id = $1", [
          seeded.recipient.memberId,
          now,
        ]),
      async (pool: Pool, seeded: Awaited<ReturnType<typeof seedCandidateConversation>>) =>
        pool.query("UPDATE members SET suspended_until = $2 WHERE id = $1", [
          seeded.recipient.memberId,
          new Date(now.getTime() + 86_400_000),
        ]),
      async (pool: Pool, seeded: Awaited<ReturnType<typeof seedCandidateConversation>>) =>
        pool.query(
          "UPDATE portrait_member_states SET published_version_id = NULL WHERE member_id = $1",
          [seeded.recipient.memberId],
        ),
      async (pool: Pool, seeded: Awaited<ReturnType<typeof seedCandidateConversation>>) =>
        pool.query(
          `INSERT INTO member_connections
            (id, member_a_id, member_b_id, status, created_at)
           VALUES ($1, $2, $3, 'active', $4)`,
          [
            randomUUID(),
            seeded.requester.memberId,
            seeded.recipient.memberId,
            now,
          ],
        ),
    ];

    for (const makeUnavailable of scenarios) {
      const resetPool = new Pool({ connectionString: databaseUrl });
      await resetPool.query("TRUNCATE sessions, members CASCADE");
      await resetPool.end();
      const seeded = await seedCandidateConversation();
      const pool = new Pool({ connectionString: databaseUrl });
      await makeUnavailable(pool, seeded);
      await pool.end();
      const response = await app.inject({
        method: "POST",
        url: `/api/member/recommendations/${seeded.recommendationId}/contact-request`,
        headers: { cookie: seeded.requester.cookie },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("CONTACT_REQUEST_NOT_AVAILABLE");
    }

    const resetPool = new Pool({ connectionString: databaseUrl });
    await resetPool.query("TRUNCATE sessions, members CASCADE");
    await resetPool.end();
    const stale = await seedCandidateConversation();
    const created = await app.inject({
      method: "POST",
      url: `/api/member/recommendations/${stale.recommendationId}/contact-request`,
      headers: { cookie: stale.requester.cookie },
    });
    const blockPool = new Pool({ connectionString: databaseUrl });
    await blockPool.query(
      `INSERT INTO member_blocks
        (blocker_member_id, blocked_member_id, created_at)
       VALUES ($1, $2, $3)`,
      [stale.recipient.memberId, stale.requester.memberId, now],
    );
    await blockPool.end();
    const accepted = await app.inject({
      method: "POST",
      url: `/api/member/contact-requests/${created.json().id}/accept`,
      headers: { cookie: stale.recipient.cookie },
    });
    expect(accepted.statusCode).toBe(409);
    expect(accepted.json().code).toBe("CONTACT_REQUEST_CANCELLED");
  });
});
