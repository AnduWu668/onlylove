import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp, type AppOptions } from "../src/app.js";
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
    const appOptions = {
      databaseUrl,
      mailer,
      otpSecret: "test-only-secret",
      superAdminEmail: "admin@onlylove.test",
      now: () => now,
      connectionMaintenanceIntervalMs: 10,
    };
    app = await createApp(appOptions);
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
          reason: "你们的公开资料和择偶条件相互匹配。",
        },
      }),
    ]);
    expect(JSON.stringify(inbox.json())).not.toMatch(
      /email|matchProfile|reciprocalScore|pairEvaluation/i,
    );
    expect(
      (mailer as MemoryMailer & { notifications: unknown[] }).notifications,
    ).toHaveLength(1);

    const outbox = await app.inject({
      method: "GET",
      url: "/api/member/contact-requests",
      headers: { cookie: seeded.requester.cookie },
    });
    expect(outbox.json().outgoing[0].candidate.reason).toBe(
      "你们都愿意认真讨论长期关系。",
    );
  });

  it("retries committed contact notifications without failing the request", async () => {
    class FlakyMailer extends MemoryMailer {
      requestFailures = 1;
      acceptedFailures = 1;

      override async sendContactRequest(email: string, nickname: string) {
        if (this.requestFailures-- > 0) throw new Error("smtp unavailable");
        await super.sendContactRequest(email, nickname);
      }

      override async sendContactAccepted(email: string, nickname: string) {
        if (this.acceptedFailures-- > 0) throw new Error("smtp unavailable");
        await super.sendContactAccepted(email, nickname);
      }
    }

    await app.close();
    const flakyMailer = new FlakyMailer();
    const appOptions = {
      databaseUrl,
      mailer: flakyMailer,
      otpSecret: "test-only-secret",
      superAdminEmail: "admin@onlylove.test",
      now: () => now,
      connectionMaintenanceIntervalMs: 60_000,
    };
    app = await createApp(appOptions);
    const seeded = await seedCandidateConversation();

    const created = await app.inject({
      method: "POST",
      url: `/api/member/recommendations/${seeded.recommendationId}/contact-request`,
      headers: { cookie: seeded.requester.cookie },
    });
    expect(created.statusCode).toBe(201);
    expect(flakyMailer.notifications).toHaveLength(0);

    await app.inject({
      method: "GET",
      url: "/api/member/contact-requests",
      headers: { cookie: seeded.recipient.cookie },
    });
    expect(flakyMailer.notifications).toEqual([
      expect.objectContaining({ type: "contact_request" }),
    ]);

    const accepted = await app.inject({
      method: "POST",
      url: `/api/member/contact-requests/${created.json().id}/accept`,
      headers: { cookie: seeded.recipient.cookie },
    });
    expect(accepted.statusCode).toBe(200);
    expect(
      flakyMailer.notifications.filter(({ type }) => type === "contact_accepted"),
    ).toHaveLength(1);

    await app.inject({
      method: "GET",
      url: "/api/member/contact-requests",
      headers: { cookie: seeded.recipient.cookie },
    });
    expect(
      flakyMailer.notifications.filter(({ type }) => type === "contact_accepted"),
    ).toHaveLength(2);
  });

  it("keeps a contact notification retryable when the mailer capability is unavailable", async () => {
    await app.close();
    const notifications: Array<{ email: string; nickname: string }> = [];
    const runtimeMailer: {
      sendOtp(email: string, code: string): Promise<void>;
      sendContactRequest?: (email: string, nickname: string) => Promise<void>;
    } = {
      async sendOtp() {},
    };
    app = await createApp({
      databaseUrl,
      mailer: runtimeMailer as AppOptions["mailer"],
      otpSecret: "test-only-secret",
      superAdminEmail: "admin@onlylove.test",
      now: () => now,
      connectionMaintenanceIntervalMs: 60_000,
    });
    const seeded = await seedCandidateConversation();

    const created = await app.inject({
      method: "POST",
      url: `/api/member/recommendations/${seeded.recommendationId}/contact-request`,
      headers: { cookie: seeded.requester.cookie },
    });
    expect(created.statusCode).toBe(201);
    expect(notifications).toHaveLength(0);

    runtimeMailer.sendContactRequest = async (email, nickname) => {
      notifications.push({ email, nickname });
    };
    await app.inject({
      method: "GET",
      url: "/api/member/contact-requests",
      headers: { cookie: seeded.recipient.cookie },
    });
    expect(notifications).toEqual([
      { email: "recipient@onlylove.test", nickname: "林夏" },
    ]);
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

  it("rejects a request created while either member establishes another contact", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const requester = await seedMember(pool, {
      email: "requester@onlylove.test",
      nickname: "林夏",
      birthDate: "1992-04-12",
      gender: "female",
    });
    const firstRecipient = await seedMember(pool, {
      email: "first-recipient@onlylove.test",
      nickname: "北川",
      birthDate: "1990-03-02",
      gender: "male",
    });
    const secondRecipient = await seedMember(pool, {
      email: "second-recipient@onlylove.test",
      nickname: "远山",
      birthDate: "1991-06-08",
      gender: "male",
    });
    const first = await seedCandidateRelationship(
      pool,
      requester,
      firstRecipient,
      "ANON00000003",
    );
    const second = await seedCandidateRelationship(
      pool,
      requester,
      secondRecipient,
      "ANON00000004",
    );
    const firstRequest = await app.inject({
      method: "POST",
      url: `/api/member/recommendations/${first.recommendationId}/contact-request`,
      headers: { cookie: requester.cookie },
    });

    const lockClient = await pool.connect();
    await lockClient.query("BEGIN");
    await lockClient.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`current-contact:${requester.memberId}`],
    );
    const accepting = app.inject({
      method: "POST",
      url: `/api/member/contact-requests/${firstRequest.json().id}/accept`,
      headers: { cookie: firstRecipient.cookie },
    });
    await vi.waitFor(async () => {
      const result = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM pg_stat_activity
          WHERE wait_event = 'advisory'`,
      );
      expect(Number(result.rows[0]!.count)).toBeGreaterThanOrEqual(1);
    });
    const creating = app.inject({
      method: "POST",
      url: `/api/member/recommendations/${second.recommendationId}/contact-request`,
      headers: { cookie: requester.cookie },
    });
    await vi.waitFor(async () => {
      const [waiting, created] = await Promise.all([
        pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM pg_stat_activity
            WHERE wait_event = 'advisory'`,
        ),
        pool.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM contact_requests WHERE recommendation_id = $1",
          [second.recommendationId],
        ),
      ]);
      expect(
        Number(waiting.rows[0]!.count) >= 2 ||
          Number(created.rows[0]!.count) === 1,
      ).toBe(true);
    });
    await lockClient.query("COMMIT");
    lockClient.release();
    await pool.end();

    expect((await accepting).statusCode).toBe(200);
    const rejected = await creating;
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().code).toBe("CONTACT_REQUEST_NOT_AVAILABLE");
  });

  it("serializes accepting and rejecting the same request", async () => {
    const seeded = await seedCandidateConversation();
    const created = await app.inject({
      method: "POST",
      url: `/api/member/recommendations/${seeded.recommendationId}/contact-request`,
      headers: { cookie: seeded.requester.cookie },
    });
    const pool = new Pool({ connectionString: databaseUrl });
    const lockClient = await pool.connect();
    await lockClient.query("BEGIN");
    await lockClient.query(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`contact-request:${created.json().id}`],
    );
    const rejecting = app.inject({
      method: "POST",
      url: `/api/member/contact-requests/${created.json().id}/reject`,
      headers: { cookie: seeded.recipient.cookie },
    });
    await vi.waitFor(async () => {
      const waiting = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM pg_stat_activity
          WHERE wait_event = 'advisory'`,
      );
      expect(Number(waiting.rows[0]!.count)).toBeGreaterThanOrEqual(1);
    });
    const accepting = app.inject({
      method: "POST",
      url: `/api/member/contact-requests/${created.json().id}/accept`,
      headers: { cookie: seeded.recipient.cookie },
    });
    await vi.waitFor(async () => {
      const [waiting, connections] = await Promise.all([
        pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM pg_stat_activity
            WHERE wait_event = 'advisory'`,
        ),
        pool.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM member_connections WHERE status = 'active'",
        ),
      ]);
      expect(
        Number(waiting.rows[0]!.count) >= 2 ||
          Number(connections.rows[0]!.count) === 1,
      ).toBe(true);
    });
    await lockClient.query("COMMIT");
    lockClient.release();
    await pool.end();

    expect((await rejecting).statusCode).toBe(200);
    expect((await accepting).statusCode).toBe(409);
    const state = await app.inject({
      method: "GET",
      url: "/api/member/contact-requests",
      headers: { cookie: seeded.recipient.cookie },
    });
    expect(state.json().incoming[0].status).toBe("rejected");
    expect(state.json().currentConnection).toBeNull();
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
    const auditPool = new Pool({ connectionString: databaseUrl });
    await vi.waitFor(async () => {
      const status = await auditPool.query<{ status: string }>(
        "SELECT status FROM contact_requests WHERE id = $1",
        [expiring.json().id],
      );
      expect(status.rows[0]!.status).toBe("expired");
    });
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
    const recommendation = await auditPool.query<{ status: string }>(
      "SELECT status FROM candidate_recommendations WHERE id = $1",
      [expiringSeed.recommendationId],
    );
    const connections = await auditPool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM member_connections WHERE status = 'active'",
    );
    expect(recommendation.rows[0]!.status).toBe("requested");
    expect(connections.rows[0]!.count).toBe("0");

    await app.close();
    app = await createApp({
      databaseUrl,
      mailer,
      otpSecret: "test-only-secret",
      superAdminEmail: "admin@onlylove.test",
      now: () => now,
      connectionMaintenanceIntervalMs: 60_000,
    });
    await auditPool.query("TRUNCATE sessions, members CASCADE");
    const requester = await seedMember(auditPool, {
      email: "expiry-requester@onlylove.test",
      nickname: "林夏",
      birthDate: "1992-04-12",
      gender: "female",
    });
    const firstRecipient = await seedMember(auditPool, {
      email: "expired-recipient@onlylove.test",
      nickname: "北川",
      birthDate: "1990-03-02",
      gender: "male",
    });
    const secondRecipient = await seedMember(auditPool, {
      email: "accepted-recipient@onlylove.test",
      nickname: "远山",
      birthDate: "1991-06-08",
      gender: "male",
    });
    const firstRelationship = await seedCandidateRelationship(
      auditPool,
      requester,
      firstRecipient,
      "ANON00000005",
    );
    const secondRelationship = await seedCandidateRelationship(
      auditPool,
      requester,
      secondRecipient,
      "ANON00000006",
    );
    const firstRequest = await app.inject({
      method: "POST",
      url: `/api/member/recommendations/${firstRelationship.recommendationId}/contact-request`,
      headers: { cookie: requester.cookie },
    });
    const secondRequest = await app.inject({
      method: "POST",
      url: `/api/member/recommendations/${secondRelationship.recommendationId}/contact-request`,
      headers: { cookie: requester.cookie },
    });
    await auditPool.query(
      "UPDATE contact_requests SET expires_at = $2 WHERE id = $1",
      [firstRequest.json().id, now],
    );
    const acceptedSecond = await app.inject({
      method: "POST",
      url: `/api/member/contact-requests/${secondRequest.json().id}/accept`,
      headers: { cookie: secondRecipient.cookie },
    });
    expect(acceptedSecond.statusCode).toBe(200);
    const related = await auditPool.query<{ status: string }>(
      "SELECT status FROM contact_requests",
    );
    await auditPool.end();
    expect(related.rows.map(({ status }) => status).sort()).toEqual([
      "accepted",
      "expired",
    ]);
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

  it("keeps one private human conversation live, idempotent, unread, and read-only after contact becomes unavailable", async () => {
    const seeded = await seedCandidateConversation();
    const outsiderPool = new Pool({ connectionString: databaseUrl });
    const outsider = await seedMember(outsiderPool, {
      email: "outsider@onlylove.test",
      nickname: "旁观者",
      birthDate: "1991-02-03",
      gender: "female",
    });
    const admin = await seedMember(outsiderPool, {
      email: "ordinary-admin@onlylove.test",
      nickname: "普通管理员",
      birthDate: "1988-01-02",
      gender: "male",
    });
    await outsiderPool.query("UPDATE members SET role = 'admin' WHERE id = $1", [
      admin.memberId,
    ]);
    await outsiderPool.end();

    const request = await app.inject({
      method: "POST",
      url: `/api/member/recommendations/${seeded.recommendationId}/contact-request`,
      headers: { cookie: seeded.requester.cookie },
    });
    const accepted = await app.inject({
      method: "POST",
      url: `/api/member/contact-requests/${request.json().id}/accept`,
      headers: { cookie: seeded.recipient.cookie },
    });
    expect(accepted.statusCode).toBe(200);

    const initialState = await app.inject({
      method: "GET",
      url: "/api/member/contact-requests",
      headers: { cookie: seeded.requester.cookie },
    });
    const conversationId = initialState.json().currentConnection.conversation.id;
    expect(initialState.json().currentConnection.conversation.unreadCount).toBe(0);

    for (const cookie of [outsider.cookie, admin.cookie]) {
      const hidden = await app.inject({
        method: "GET",
        url: `/api/member/human-conversations/${conversationId}`,
        headers: { cookie },
      });
      expect(hidden.statusCode).toBe(404);
      const hiddenSend = await app.inject({
        method: "POST",
        url: `/api/member/human-conversations/${conversationId}/messages`,
        headers: { cookie },
        payload: {
          clientMessageId: randomUUID(),
          content: "不应保存的越权消息",
        },
      });
      expect(hiddenSend.statusCode).toBe(404);
      const hiddenEvents = await app.inject({
        method: "GET",
        url: `/api/member/human-conversations/${conversationId}/events?after=0`,
        headers: { cookie },
      });
      expect(hiddenEvents.statusCode).toBe(404);
    }

    const clientMessageId = randomUUID();
    const notificationsBefore = mailer.notifications.length;
    const first = await app.inject({
      method: "POST",
      url: `/api/member/human-conversations/${conversationId}/messages`,
      headers: { cookie: seeded.requester.cookie },
      payload: {
        clientMessageId,
        content: "可以加我微信 onlylove_2026，电话 13800138000。",
      },
    });
    const retried = await app.inject({
      method: "POST",
      url: `/api/member/human-conversations/${conversationId}/messages`,
      headers: { cookie: seeded.requester.cookie },
      payload: {
        clientMessageId,
        content: "可以加我微信 onlylove_2026，电话 13800138000。",
      },
    });
    expect([first.statusCode, retried.statusCode]).toEqual([201, 200]);
    expect(retried.json().message.id).toBe(first.json().message.id);
    expect(mailer.notifications).toHaveLength(notificationsBefore);

    const unreadState = await app.inject({
      method: "GET",
      url: "/api/member/contact-requests",
      headers: { cookie: seeded.recipient.cookie },
    });
    expect(unreadState.json().currentConnection.conversation.unreadCount).toBe(1);

    const history = await app.inject({
      method: "GET",
      url: `/api/member/human-conversations/${conversationId}`,
      headers: { cookie: seeded.recipient.cookie },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({
      conversationId,
      canSend: true,
      otherMember: { displayName: "林夏", deleted: false },
      unreadCount: 0,
      messages: [
        {
          id: first.json().message.id,
          sender: "other",
          content: "可以加我微信 onlylove_2026，电话 13800138000。",
          sequence: 1,
        },
      ],
    });

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("test server missing");
    const abort = new AbortController();
    const events = await fetch(
      `http://127.0.0.1:${address.port}/api/member/human-conversations/${conversationId}/events?after=1`,
      {
        headers: { cookie: seeded.recipient.cookie },
        signal: abort.signal,
      },
    );
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const reader = events.body!.getReader();
    const liveClientMessageId = randomUUID();
    const liveMessage = await app.inject({
      method: "POST",
      url: `/api/member/human-conversations/${conversationId}/messages`,
      headers: { cookie: seeded.requester.cookie },
      payload: { clientMessageId: liveClientMessageId, content: "今晚见面聊聊？" },
    });
    expect(liveMessage.statusCode).toBe(201);
    let streamed = "";
    while (!streamed.includes(liveMessage.json().message.id)) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("SSE message timeout")), 2_000),
        ),
      ]);
      if (chunk.done) break;
      streamed += new TextDecoder().decode(chunk.value);
    }
    expect(streamed).toContain("event: message");
    expect(streamed).toContain("今晚见面聊聊？");
    abort.abort();

    const recipientMessage = await app.inject({
      method: "POST",
      url: `/api/member/human-conversations/${conversationId}/messages`,
      headers: { cookie: seeded.recipient.cookie },
      payload: { clientMessageId: randomUUID(), content: "我也可以发送。" },
    });
    expect(recipientMessage.statusCode).toBe(201);
    expect(recipientMessage.json().message).toMatchObject({
      sender: "self",
      content: "我也可以发送。",
    });

    const reconnectAbort = new AbortController();
    const reconnectedEvents = await fetch(
      `http://127.0.0.1:${address.port}/api/member/human-conversations/${conversationId}/events?after=0`,
      {
        headers: {
          cookie: seeded.recipient.cookie,
          "Last-Event-ID": String(liveMessage.json().message.sequence),
        },
        signal: reconnectAbort.signal,
      },
    );
    const reconnectReader = reconnectedEvents.body!.getReader();
    let reconnected = "";
    while (!reconnected.includes(recipientMessage.json().message.id)) {
      const chunk = await Promise.race([
        reconnectReader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("SSE reconnect timeout")), 2_000),
        ),
      ]);
      if (chunk.done) break;
      reconnected += new TextDecoder().decode(chunk.value);
    }
    reconnectAbort.abort();
    expect(reconnected).not.toContain(first.json().message.id);
    expect(reconnected).not.toContain(liveMessage.json().message.id);
    expect(reconnected).toContain(recipientMessage.json().message.id);

    const availabilityPool = new Pool({ connectionString: databaseUrl });
    const unavailable = async () =>
      app.inject({
        method: "POST",
        url: `/api/member/human-conversations/${conversationId}/messages`,
        headers: { cookie: seeded.requester.cookie },
        payload: { clientMessageId: randomUUID(), content: "还能发送吗？" },
      });
    await availabilityPool.query(
      `INSERT INTO member_blocks (blocker_member_id, blocked_member_id, created_at)
       VALUES ($1, $2, $3)`,
      [seeded.recipient.memberId, seeded.requester.memberId, now],
    );
    expect((await unavailable()).json().code).toBe("HUMAN_CONVERSATION_READ_ONLY");
    await availabilityPool.query("DELETE FROM member_blocks");
    await availabilityPool.query("UPDATE members SET suspended_until = $2 WHERE id = $1", [
      seeded.recipient.memberId,
      new Date(now.getTime() + 86_400_000),
    ]);
    expect((await unavailable()).json().code).toBe("HUMAN_CONVERSATION_READ_ONLY");
    await availabilityPool.query("UPDATE members SET suspended_until = NULL, deleted_at = $2 WHERE id = $1", [
      seeded.recipient.memberId,
      now,
    ]);
    expect((await unavailable()).json().code).toBe("HUMAN_CONVERSATION_READ_ONLY");
    const retained = await app.inject({
      method: "GET",
      url: `/api/member/human-conversations/${conversationId}`,
      headers: { cookie: seeded.requester.cookie },
    });
    expect(retained.json().otherMember).toEqual({
      displayName: "已注销成员（历史消息已保留）",
      deleted: true,
    });
    await availabilityPool.query("UPDATE members SET deleted_at = NULL WHERE id = $1", [
      seeded.recipient.memberId,
    ]);
    await availabilityPool.query(
      "UPDATE member_connections SET status = 'ended', ended_at = $2 WHERE id = $1",
      [accepted.json().connection.id, now],
    );
    expect((await unavailable()).json().code).toBe("HUMAN_CONVERSATION_READ_ONLY");
    await availabilityPool.end();
  });

  it("collects seven-day decisions without ending silent contacts and confirms only mutual proposals", async () => {
    const seeded = await seedCandidateConversation();
    const request = await app.inject({
      method: "POST",
      url: `/api/member/recommendations/${seeded.recommendationId}/contact-request`,
      headers: { cookie: seeded.requester.cookie },
    });
    const accepted = await app.inject({
      method: "POST",
      url: `/api/member/contact-requests/${request.json().id}/accept`,
      headers: { cookie: seeded.recipient.cookie },
    });
    const connectionId = accepted.json().connection.id;

    const early = await app.inject({
      method: "POST",
      url: `/api/member/connections/${connectionId}/followup`,
      headers: { cookie: seeded.requester.cookie },
      payload: { decision: "continue" },
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe("FOLLOWUP_NOT_DUE");

    now = new Date(now.getTime() + 8 * 86_400_000);
    const silent = await app.inject({
      method: "GET",
      url: "/api/member/contact-requests",
      headers: { cookie: seeded.requester.cookie },
    });
    expect(silent.json().currentConnection).toMatchObject({
      id: connectionId,
      relationshipStatus: "active",
      followup: {
        due: true,
        myDecision: null,
        mutualContinue: false,
        confirmation: "none",
      },
    });
    expect(
      mailer.notifications.filter(({ type }) => type === "connection_followup"),
    ).toHaveLength(2);

    const requesterContinues = await app.inject({
      method: "POST",
      url: `/api/member/connections/${connectionId}/followup`,
      headers: { cookie: seeded.requester.cookie },
      payload: { decision: "continue" },
    });
    expect(requesterContinues.statusCode).toBe(200);
    expect(requesterContinues.json().currentConnection.followup).toMatchObject({
      myDecision: "continue",
      mutualContinue: false,
    });

    const recipientContinues = await app.inject({
      method: "POST",
      url: `/api/member/connections/${connectionId}/followup`,
      headers: { cookie: seeded.recipient.cookie },
      payload: { decision: "continue" },
    });
    expect(
      recipientContinues.json().currentConnection.followup.mutualContinue,
    ).toBe(true);

    const proposal = await app.inject({
      method: "POST",
      url: `/api/member/connections/${connectionId}/followup`,
      headers: { cookie: seeded.requester.cookie },
      payload: { decision: "confirm" },
    });
    expect(proposal.json().currentConnection).toMatchObject({
      relationshipStatus: "active",
      followup: { confirmation: "proposed_by_me" },
    });

    const recipientBeforeAccepting = await app.inject({
      method: "GET",
      url: "/api/member/contact-requests",
      headers: { cookie: seeded.recipient.cookie },
    });
    expect(
      recipientBeforeAccepting.json().currentConnection.followup.confirmation,
    ).toBe("proposed_to_me");

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/member/connections/${connectionId}/followup`,
      headers: { cookie: seeded.recipient.cookie },
      payload: { decision: "confirm" },
    });
    expect(confirmed.json().currentConnection).toMatchObject({
      relationshipStatus: "confirmed",
      followup: { confirmation: "confirmed", mutualContinue: true },
    });
    const confirmedConversation = await app.inject({
      method: "GET",
      url: `/api/member/human-conversations/${confirmed.json().currentConnection.conversation.id}`,
      headers: { cookie: seeded.requester.cookie },
    });
    expect(confirmedConversation.json().canSend).toBe(true);
  });

  it("ends immediately, keeps each review private, and requires a new published version before individual resume", async () => {
    const seeded = await seedCandidateConversation();
    const alternatePool = new Pool({ connectionString: databaseUrl });
    const alternateRecipient = await seedMember(alternatePool, {
      email: "alternate-recipient@onlylove.test",
      nickname: "远山",
      birthDate: "1991-06-08",
      gender: "male",
    });
    const alternate = await seedCandidateRelationship(
      alternatePool,
      seeded.requester,
      alternateRecipient,
      "ANON00000009",
    );
    await alternatePool.end();
    const request = await app.inject({
      method: "POST",
      url: `/api/member/recommendations/${seeded.recommendationId}/contact-request`,
      headers: { cookie: seeded.requester.cookie },
    });
    const accepted = await app.inject({
      method: "POST",
      url: `/api/member/contact-requests/${request.json().id}/accept`,
      headers: { cookie: seeded.recipient.cookie },
    });
    const connectionId = accepted.json().connection.id;
    const state = await app.inject({
      method: "GET",
      url: "/api/member/contact-requests",
      headers: { cookie: seeded.requester.cookie },
    });
    const conversationId = state.json().currentConnection.conversation.id;
    now = new Date(now.getTime() + 7 * 86_400_000);

    const ended = await app.inject({
      method: "POST",
      url: `/api/member/connections/${connectionId}/followup`,
      headers: { cookie: seeded.requester.cookie },
      payload: { decision: "end" },
    });
    expect(ended.statusCode).toBe(200);
    expect(ended.json()).toMatchObject({
      currentConnection: null,
      recovery: { connectionId, status: "review_required" },
    });
    const recipientState = await app.inject({
      method: "GET",
      url: "/api/member/contact-requests",
      headers: { cookie: seeded.recipient.cookie },
    });
    expect(recipientState.json().recovery.status).toBe("review_required");

    const history = await app.inject({
      method: "GET",
      url: `/api/member/human-conversations/${conversationId}`,
      headers: { cookie: seeded.recipient.cookie },
    });
    expect(history.json().canSend).toBe(false);

    const recoveryCannotBeBypassed = await app.inject({
      method: "POST",
      url: `/api/member/recommendations/${alternate.recommendationId}/contact-request`,
      headers: { cookie: seeded.requester.cookie },
    });
    expect(recoveryCannotBeBypassed.statusCode).toBe(409);
    expect(recoveryCannotBeBypassed.json().code).toBe(
      "CONTACT_REQUEST_NOT_AVAILABLE",
    );

    const reviewPool = new Pool({ connectionString: databaseUrl });
    await reviewPool.query(
      `UPDATE connection_recoveries
          SET reviewed_at = $3
        WHERE connection_id = $1 AND member_id = $2`,
      [connectionId, seeded.requester.memberId, now],
    );
    await reviewPool.end();

    const prematureResume = await app.inject({
      method: "POST",
      url: `/api/member/connections/${connectionId}/resume`,
      headers: { cookie: seeded.requester.cookie },
    });
    expect(prematureResume.statusCode).toBe(409);
    expect(prematureResume.json().code).toBe("PORTRAIT_RECALIBRATION_REQUIRED");

    const pool = new Pool({ connectionString: databaseUrl });
    const nextVersionId = randomUUID();
    await pool.query(
      `INSERT INTO portrait_versions
        (id, member_id, version, client_request_id, source_draft_schema_version,
         match_profile, persona_context_schema_version, persona_context,
         calibration_schema_version, created_at)
       VALUES ($1, $2, 2, $3, 'portrait-draft-v1', '{}',
               'persona-context-v1', '复盘后的分身上下文',
               'portrait-calibration-v1', $4)`,
      [
        nextVersionId,
        seeded.requester.memberId,
        randomUUID(),
        new Date(now.getTime() + 1),
      ],
    );
    await pool.query(
      `UPDATE portrait_member_states
          SET submitted_version_id = $2, published_version_id = $2, updated_at = $3
        WHERE member_id = $1`,
      [seeded.requester.memberId, nextVersionId, new Date(now.getTime() + 1)],
    );
    await pool.end();

    const resumed = await app.inject({
      method: "POST",
      url: `/api/member/connections/${connectionId}/resume`,
      headers: { cookie: seeded.requester.cookie },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().recovery.status).toBe("resumed");
    expect(recipientState.json().recovery.status).toBe("review_required");

    const adminPool = new Pool({ connectionString: databaseUrl });
    const admin = await seedMember(adminPool, {
      email: "metrics-admin@onlylove.test",
      nickname: "指标管理员",
      birthDate: "1988-01-02",
      gender: "male",
    });
    await adminPool.query("UPDATE members SET role = 'super_admin' WHERE id = $1", [
      admin.memberId,
    ]);
    await adminPool.end();
    const metrics = await app.inject({
      method: "GET",
      url: "/api/admin/relationship-metrics",
      headers: { cookie: admin.cookie },
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json()).toMatchObject({
      dueConnections: 1,
      mutualContinue: 0,
      noFeedback: 0,
      ended: 1,
      confirmed: 0,
      recoveryPending: 1,
      resumed: 1,
      mutualContinueRate: 0,
    });
  });

  it("serializes ending a contact ahead of concurrently queued human messages", async () => {
    const seeded = await seedCandidateConversation();
    const request = await app.inject({
      method: "POST",
      url: `/api/member/recommendations/${seeded.recommendationId}/contact-request`,
      headers: { cookie: seeded.requester.cookie },
    });
    const accepted = await app.inject({
      method: "POST",
      url: `/api/member/contact-requests/${request.json().id}/accept`,
      headers: { cookie: seeded.recipient.cookie },
    });
    const state = await app.inject({
      method: "GET",
      url: "/api/member/contact-requests",
      headers: { cookie: seeded.requester.cookie },
    });
    const conversationId = state.json().currentConnection.conversation.id;
    now = new Date(now.getTime() + 7 * 86_400_000);

    const pool = new Pool({ connectionString: databaseUrl });
    const lock = await pool.connect();
    await lock.query("BEGIN");
    await lock.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      conversationId,
    ]);
    const ending = app.inject({
      method: "POST",
      url: `/api/member/connections/${accepted.json().connection.id}/followup`,
      headers: { cookie: seeded.requester.cookie },
      payload: { decision: "end" },
    });
    await vi.waitFor(async () => {
      const waiting = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM pg_stat_activity WHERE wait_event = 'advisory'",
      );
      expect(Number(waiting.rows[0]!.count)).toBeGreaterThanOrEqual(1);
    });
    const sending = app.inject({
      method: "POST",
      url: `/api/member/human-conversations/${conversationId}/messages`,
      headers: { cookie: seeded.recipient.cookie },
      payload: { clientMessageId: randomUUID(), content: "不应越过结束状态" },
    });
    await vi.waitFor(async () => {
      const waiting = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM pg_stat_activity WHERE wait_event = 'advisory'",
      );
      expect(Number(waiting.rows[0]!.count)).toBeGreaterThanOrEqual(2);
    });
    await lock.query("COMMIT");
    lock.release();

    expect((await ending).statusCode).toBe(200);
    const message = await sending;
    expect(message.statusCode).toBe(409);
    expect(message.json().code).toBe("HUMAN_CONVERSATION_READ_ONLY");
    await pool.end();
  });
});
