import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadRootEnv } from "../src/env.js";
import type { DeterministicAgentModelOptions } from "../src/modules/agent-engine/engine.js";
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
    const cookie = response.cookies[0]?.name + "=" + response.cookies[0]?.value;
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

  async function completeFixedInterview(cookie: string, consumeFollowup = true) {
    for (;;) {
      const state = await app.inject({
        method: "GET",
        url: "/api/member/portrait/interview",
        headers: { cookie },
      });
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
          freeText:
            state.json().fixedInterview.answered === 0
              ? "也会看这件事对两个人的影响。"
              : "",
        },
      });
      expect(response.statusCode).toBe(200);
      const data = response.json();
      if (data.autoFollowup) {
        if (!consumeFollowup) return data;
        const events = await app.inject({
          method: "GET",
          url: data.autoFollowup.eventsUrl,
          headers: { cookie },
        });
        expect(events.statusCode).toBe(200);
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
          },
        ],
        extractReply: JSON.stringify(emptyPortraitDraft()),
      },
    });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("finishes ten neutral fixed questions before exposing dynamic interview", async () => {
    const { memberCookie: cookie } =
      await inviteAndSignInMember("fixed-interview@onlylove.test");
    const blocked = await app.inject({
      method: "POST",
      url: "/api/member/interview/messages",
      headers: { cookie },
      payload: {
        clientMessageId: "f1f77376-d292-4450-bec7-83bf2f1b87c8",
        content: "还没完成固定题。",
      },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ code: "FIXED_INTERVIEW_REQUIRED" });

    const first = await app.inject({
      method: "GET",
      url: "/api/member/portrait/interview",
      headers: { cookie },
    });
    const repeated = await app.inject({
      method: "GET",
      url: "/api/member/portrait/interview",
      headers: { cookie },
    });
    expect(first.json()).toEqual(repeated.json());
    expect(first.json()).toMatchObject({
      fixedInterview: { answered: 0, total: 10, completed: false },
      progress: { completed: 0, total: 8 },
    });
    expect(first.json().fixedInterview.question.options).toHaveLength(4);
    expect(JSON.stringify(first.json())).not.toMatch(
      /selfTendency|confidence|evidenceMessageIds/,
    );

    const question = first.json().fixedInterview.question;
    const combined = await app.inject({
      method: "POST",
      url: "/api/member/portrait/interview/fixed-answers",
      headers: { cookie },
      payload: {
        questionId: question.id,
        selectedOptionIds: [question.options[0].id, question.options[1].id],
        noneApplies: false,
        freeText: "我会根据影响的人和时间窗口组合考虑。",
      },
    });
    expect(combined.json().fixedInterview.answered).toBe(1);

    const completed = await completeFixedInterview(cookie, false);
    expect(completed).toMatchObject({
      fixedInterview: {
        answered: 10,
        total: 10,
        completed: true,
        question: null,
      },
      progress: { completed: 0, total: 8 },
    });
    expect(completed.autoFollowup.eventsUrl).toContain("/events");
    const pending = await app.inject({
      method: "GET",
      url: "/api/member/interview",
      headers: { cookie },
    });
    expect(pending.json().autoFollowup).toEqual(completed.autoFollowup);
    const followup = await app.inject({
      method: "GET",
      url: pending.json().autoFollowup.eventsUrl,
      headers: { cookie },
    });
    expect(followup.body).toContain("event: done");
    const messages = await app.inject({
      method: "GET",
      url: "/api/member/interview",
      headers: { cookie },
    });
    expect(
      messages
        .json()
        .messages.filter((message: { role: string }) => message.role === "member"),
    ).toHaveLength(10);
    expect(
      messages
        .json()
        .messages.some((message: { role: string }) => message.role === "agent"),
    ).toBe(true);
    expect(messages.json().messages[0].content).toContain(
      "我会根据影响的人和时间窗口组合考虑。",
    );
  });

  it("shows only general progress when new evidence reaches medium confidence", async () => {
    await app.close();
    mailer = new MemoryMailer();
    const agentModel: DeterministicAgentModelOptions = {
      provider: "deterministic-fake",
      model: "portrait-progress-v1",
      reply: "能说说什么经历让你形成这个判断吗？",
      extractReply: JSON.stringify(emptyPortraitDraft()),
    };
    app = await createApp({
      databaseUrl,
      mailer,
      otpSecret: "test-only-secret",
      superAdminEmail: "admin@onlylove.test",
      now: () => new Date("2026-08-20T08:00:00.000Z"),
      agentModel,
    });
    const { memberCookie: cookie } =
      await inviteAndSignInMember("progress-interview@onlylove.test");
    await completeFixedInterview(cookie);

    const submit = async (
      clientMessageId: string,
      content: string,
      addConfidentEvidence = false,
    ) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/member/interview/messages",
        headers: { cookie },
        payload: { clientMessageId, content },
      });
      if (addConfidentEvidence) {
        const pool = new Pool({ connectionString: databaseUrl });
        const evidence = await pool.query<{ id: string }>(
          "SELECT id FROM conversation_messages WHERE client_message_id = $1",
          [clientMessageId],
        );
        await pool.end();
        const draft = emptyPortraitDraft();
        draft.values = {
          ...draft.values,
          selfTendency: "重要决定前会先理解彼此的理由。",
          confidence: "medium",
          evidenceMessageIds: [evidence.rows[0]!.id],
        };
        agentModel.extractReply = JSON.stringify(draft);
      }
      return app.inject({
        method: "GET",
        url: response.json().eventsUrl,
        headers: { cookie },
      });
    };
    const first = await submit(
      "4c33f48a-5481-4366-b934-0c86534f2a50",
      "我想补充当时是怎样考虑的。",
      true,
    );
    expect(first.body).toContain("event: progress");
    expect(first.body).toContain("我对你的理解又清楚了一些");

    const state = await app.inject({
      method: "GET",
      url: "/api/member/portrait/interview",
      headers: { cookie },
    });
    expect(state.json()).toMatchObject({
      progress: { completed: 1, total: 8 },
    });
    expect(JSON.stringify(state.json())).not.toContain("重要决定");

    const unchanged = await submit(
      "c7ce9080-9cec-44e5-b488-8ea27e41fd56",
      "我暂时没有更多补充。",
    );
    expect(unchanged.body).not.toContain("event: progress");
    expect(unchanged.body).not.toContain("我对你的理解又清楚了一些");
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
    await completeFixedInterview(cookie);
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
    expect(conversation.json().messages.slice(-2)).toEqual([
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
    const submittedRuns = runs
      .json()
      .runs.filter(
        (run: { jobId: string }) => run.jobId === submitted.json().jobId,
      );
    expect(submittedRuns).toHaveLength(4);
    expect(
      submittedRuns
        .filter((run: { task: string }) => run.task === "continue_interview")
        .map((run: { retryCount: number }) => run.retryCount),
    ).toEqual([0, 1, 2]);
    expect(submittedRuns.at(-1)).toEqual(
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

    const savedAnswer = conversation.json().messages.at(-1);
    const pool = new Pool({ connectionString: databaseUrl });
    await pool.query(
      "UPDATE conversation_messages SET sequence = 14 WHERE id = $1",
      [savedAnswer.id],
    );
    await pool.query(
      "INSERT INTO conversation_messages (id, conversation_id, role, content, sequence, created_at) VALUES ($1, $2, 'agent', $3, 13, $4)",
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
        extractReply: JSON.stringify(emptyPortraitDraft()),
      },
    });
    const { adminCookie, memberCookie: cookie } =
      await inviteAndSignInMember("failed-interview@onlylove.test");
    await completeFixedInterview(cookie);
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
    const firstRuns = runs
      .json()
      .runs.filter((run: { jobId: string }) => run.jobId === first.json().jobId);
    expect(firstRuns).toHaveLength(4);
    expect(
      firstRuns.every((run: { error: string | null }) =>
        run.error === null || run.error.includes("provider unavailable"),
      ),
    ).toBe(true);

    const replay = await app.inject({
      method: "GET",
      url: first.json().eventsUrl,
      headers: { cookie },
    });
    expect(replay.body).toContain("event: error");

    const runsAfterReplay = await app.inject({
      method: "GET",
      url: "/api/admin/agent-runs",
      headers: { cookie: adminCookie },
    });
    expect(
      runsAfterReplay
        .json()
        .runs.filter(
          (run: { jobId: string }) => run.jobId === first.json().jobId,
        ),
    ).toHaveLength(4);

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
    await completeFixedInterview(cookie);
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
        extractReply: JSON.stringify(emptyPortraitDraft()),
      },
    });
    const { memberCookie: cookie } =
      await inviteAndSignInMember("stale-interview@onlylove.test");
    await completeFixedInterview(cookie);
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
