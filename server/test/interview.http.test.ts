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

describe("first portrait interview HTTP and Agent Engine seam", () => {
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
    return response.cookies[0]?.name + "=" + response.cookies[0]?.value;
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
      "TRUNCATE agent_runs, agent_jobs, own_agent_daily_quotas, conversation_messages, conversations, sessions, otp_challenges, invitations, members CASCADE",
    );
    await pool.end();
    mailer = new MemoryMailer();
    app = await createApp({
      databaseUrl,
      mailer,
      otpSecret: "test-only-secret",
      superAdminEmail: "admin@onlylove.test",
      now: () => new Date("2026-08-20T08:00:00.000Z"),
      agentModel: {
        provider: "deterministic-fake",
        model: "interviewer-primary-v1",
        backupModel: "interviewer-backup-v1",
        attempts: [
          { error: "primary unavailable" },
          { error: "primary unavailable" },
          {
            model: "interviewer-backup-v1",
            reply:
              "你提到冲突时需要先冷静一下。通常什么信号会让你愿意重新开始沟通？",
            systemPromptIncludes: ["林夏", "上海", "稳定的专业工作"],
          },
        ],
      },
    });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("streams and persists the first interview answer with an auditable run", async () => {
    const { adminCookie, memberCookie: cookie } =
      await inviteAndSignInMember("interview@onlylove.test");
    const profile = await app.inject({
      method: "PUT",
      url: "/api/member/profile",
      headers: { cookie },
      payload: {
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
      },
    });
    expect(profile.statusCode).toBe(200);
    const clientMessageId = "e49f9560-17f8-4929-8da8-554a93d25b31";
    const submitted = await app.inject({
      method: "POST",
      url: "/api/member/interview/messages",
      headers: { cookie },
      payload: {
        clientMessageId,
        content: "我在冲突时通常需要先冷静一下。",
      },
    });

    expect(submitted.statusCode).toBe(202);
    expect(submitted.json()).toMatchObject({ quotaRemaining: 99 });

    const events = await app.inject({
      method: "GET",
      url: submitted.json().eventsUrl,
      headers: { cookie },
    });
    expect(events.statusCode).toBe(200);
    expect(events.headers["content-type"]).toContain("text/event-stream");
    expect(events.body).toContain("event: delta");
    const streamedText = events.body
      .split("\n\n")
      .filter((event) => event.startsWith("event: delta"))
      .map((event) => {
        const data = event.split("\ndata: ")[1]!;
        return (JSON.parse(data) as { text: string }).text;
      })
      .join("");
    expect(streamedText).toContain("重新开始沟通");
    expect(events.body).toContain("event: done");

    const conversation = await app.inject({
      method: "GET",
      url: "/api/member/interview",
      headers: { cookie },
    });
    expect(conversation.statusCode).toBe(200);
    expect(conversation.json().messages).toEqual([
      expect.objectContaining({
        role: "member",
        content: "我在冲突时通常需要先冷静一下。",
      }),
      expect.objectContaining({
        role: "agent",
        content: expect.stringContaining("重新开始沟通"),
      }),
    ]);

    const runs = await app.inject({
      method: "GET",
      url: "/api/admin/agent-runs",
      headers: { cookie: adminCookie },
    });
    expect(runs.statusCode).toBe(200);
    expect(runs.json().runs).toHaveLength(3);
    expect(
      runs.json().runs.map((run: { retryCount: number }) => run.retryCount),
    ).toEqual([0, 1, 2]);
    expect(runs.json().runs.at(-1)).toEqual(
      expect.objectContaining({
        role: "portrait_interviewer",
        task: "continue_interview",
        definitionVersion: "portrait-interviewer-v1",
        promptVersion: "portrait-interviewer-prompt-v1",
        schemaVersion: null,
        conversationId: submitted.json().conversationId,
        jobId: submitted.json().jobId,
        provider: "deterministic-fake",
        requestedModel: "interviewer-backup-v1",
        actualModel: "interviewer-backup-v1",
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
        latencyMs: expect.any(Number),
        retryCount: 2,
        switchedModel: true,
        error: null,
        estimatedCostMicroCny: 0,
        pricingEffectiveDate: null,
      }),
    );

    const savedAnswer = conversation.json().messages[1];
    const pool = new Pool({ connectionString: databaseUrl });
    await pool.query(
      "UPDATE conversation_messages SET sequence = 4 WHERE id = $1",
      [savedAnswer.id],
    );
    await pool.query(
      "INSERT INTO conversation_messages (id, conversation_id, role, content, sequence, created_at) VALUES ($1, $2, 'agent', $3, 2, $4)",
      [
        "9f74e1ab-0d63-4d5f-b225-165c9fce7e58",
        submitted.json().conversationId,
        "这是另一个任务的回答。",
        new Date("2026-08-20T08:01:00.000Z"),
      ],
    );
    await pool.end();
    const replay = await app.inject({
      method: "GET",
      url: submitted.json().eventsUrl,
      headers: { cookie },
    });
    expect(replay.body).toContain("重新开始沟通");
    expect(replay.body).not.toContain("另一个任务的回答");
  });

  it("does not double-charge an idempotent message and refunds a final failure", async () => {
    await app.close();
    mailer = new MemoryMailer();
    app = await createApp({
      databaseUrl,
      mailer,
      otpSecret: "test-only-secret",
      superAdminEmail: "admin@onlylove.test",
      now: () => new Date("2026-08-20T08:00:00.000Z"),
      agentModel: {
        provider: "deterministic-fake",
        model: "interviewer-test-v1",
        error: "provider unavailable",
      },
    });
    const { adminCookie, memberCookie: cookie } =
      await inviteAndSignInMember("failed-interview@onlylove.test");
    const payload = {
      clientMessageId: "c62d797e-2e07-4789-bf1e-a07f1dfec3bd",
      content: "我很难描述自己的边界。",
    };

    const first = await app.inject({
      method: "POST",
      url: "/api/member/interview/messages",
      headers: { cookie },
      payload,
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/member/interview/messages",
      headers: { cookie },
      payload,
    });
    expect(duplicate.json()).toMatchObject({
      jobId: first.json().jobId,
      quotaRemaining: 99,
    });

    const events = await app.inject({
      method: "GET",
      url: first.json().eventsUrl,
      headers: { cookie },
    });
    expect(events.body).toContain("event: error");
    expect(events.body).toContain("MODEL_REQUEST_FAILED");

    const runs = await app.inject({
      method: "GET",
      url: "/api/admin/agent-runs",
      headers: { cookie: adminCookie },
    });
    expect(runs.json().runs).toHaveLength(3);
    expect(
      runs
        .json()
        .runs.every((run: { error: string | null }) =>
          run.error?.includes("provider unavailable"),
        ),
    ).toBe(true);

    const afterRefund = await app.inject({
      method: "POST",
      url: "/api/member/interview/messages",
      headers: { cookie },
      payload: {
        clientMessageId: "5a280026-baff-49bf-8810-6e87a7bbbe5d",
        content: "我想换个方式说明。",
      },
    });
    expect(afterRefund.json()).toMatchObject({ quotaRemaining: 99 });
  });

  it("allows only one active interview job per conversation", async () => {
    const { memberCookie: cookie } =
      await inviteAndSignInMember("serial-interview@onlylove.test");
    const first = await app.inject({
      method: "POST",
      url: "/api/member/interview/messages",
      headers: { cookie },
      payload: {
        clientMessageId: "0f59e003-3b7f-43ca-adde-752bad364f06",
        content: "第一条消息。",
      },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/member/interview/messages",
      headers: { cookie },
      payload: {
        clientMessageId: "6c275783-6fa4-47ed-9049-00ef5054138a",
        content: "第二条消息。",
      },
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ code: "INTERVIEW_IN_PROGRESS" });
  });

  it("reclaims a running job left behind by a stopped process", async () => {
    await app.close();
    mailer = new MemoryMailer();
    app = await createApp({
      databaseUrl,
      mailer,
      otpSecret: "test-only-secret",
      superAdminEmail: "admin@onlylove.test",
      now: () => new Date("2026-08-20T08:00:00.000Z"),
      agentModel: {
        provider: "deterministic-fake",
        model: "interviewer-test-v1",
        reply: "可以再多说一点吗？",
      },
    });
    const { memberCookie: cookie } =
      await inviteAndSignInMember("stale-interview@onlylove.test");
    const submitted = await app.inject({
      method: "POST",
      url: "/api/member/interview/messages",
      headers: { cookie },
      payload: {
        clientMessageId: "db7c59dd-a4ac-4b71-b70e-58735c2388b2",
        content: "进程退出前留下的消息。",
      },
    });
    const pool = new Pool({ connectionString: databaseUrl });
    await pool.query(
      "UPDATE agent_jobs SET status = 'running', started_at = $1 WHERE id = $2",
      [new Date("2026-08-20T07:00:00.000Z"), submitted.json().jobId],
    );
    await pool.end();

    const events = await app.inject({
      method: "GET",
      url: submitted.json().eventsUrl,
      headers: { cookie },
    });

    expect(events.body).toContain("event: done");
    expect(events.body).not.toContain("JOB_NOT_AVAILABLE");
  });
});
