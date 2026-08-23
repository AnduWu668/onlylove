import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadRootEnv } from "../src/env.js";
import { MemoryMailer } from "../src/modules/members/mailer.js";
import { PORTRAIT_DIMENSIONS } from "../src/modules/portraits/questions.js";
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

const matchingReply = JSON.stringify({
  schemaVersion: "pair-evaluation-schema-v0",
  rubricVersion: "matching-rubric-v0",
  structuredConditionStatus: "pass",
  dimensions: PORTRAIT_DIMENSIONS.map((dimension) => ({
    dimension,
    aToB: 82,
    bToA: 80,
    interactionReason: "双方愿意讨论长期关系中的具体安排。",
    hardBoundaryStatus: "pass",
  })),
  safeRecommendationReason: "你们都愿意认真讨论长期关系，可以进一步了解彼此。",
});
const UUID_PATTERN = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/iu;

function portraitReply(prompt: string) {
  const evidenceId = prompt.match(UUID_PATTERN)?.[0];
  if (!evidenceId) throw new Error("Deterministic extraction prompt has no evidence ID");
  const draft = emptyPortraitDraft();
  for (const [dimension, value] of Object.entries(draft)) {
    value.selfTendency = `我愿意讨论${dimension}的具体安排。`;
    value.partnerExpectation = `希望伴侣也愿意协商${dimension}。`;
    value.importance = 3;
    value.confidence = "medium";
    value.evidenceMessageIds = [evidenceId];
  }
  return JSON.stringify(draft);
}

describe("issue 17 no-photo MVP acceptance HTTP seam", () => {
  let app: FastifyInstance;
  let mailer: MemoryMailer;
  let now: Date;

  async function api(
    method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT",
    url: string,
    cookie?: string,
    payload?: unknown,
    expected = 200,
  ) {
    const response = await app.inject({
      method,
      url,
      headers: cookie ? { cookie } : undefined,
      payload,
    });
    expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(
      expected,
    );
    return response;
  }

  async function signIn(email: string, birthDate?: string) {
    const challenge = await api("POST", "/api/auth/otp", undefined, { email }, 202);
    const verified = await api("POST", "/api/auth/verify", undefined, {
      email,
      challengeId: challenge.json().challengeId,
      code: mailer.lastCodeFor(email),
      birthDate,
    });
    const cookie = `${verified.cookies[0]!.name}=${verified.cookies[0]!.value}`;
    await api("PUT", "/api/auth/password", cookie, {
      password: "secure-pass-123",
    });
    return cookie;
  }

  async function consumeAgentEvents(eventsUrl: string, cookie: string) {
    const events = await api("GET", eventsUrl, cookie);
    expect(events.body).toContain("event: done");
  }

  async function completeInterview(cookie: string) {
    for (;;) {
      const state = await api("GET", "/api/member/portrait/interview", cookie);
      if (state.json().fixedInterview.completed) break;
      const question = state.json().fixedInterview.question;
      const answer = await api(
        "POST",
        "/api/member/portrait/interview/fixed-answers",
        cookie,
        {
          questionId: question.id,
          selectedOptionIds: [question.options[0].id],
          noneApplies: false,
          freeText: "",
        },
      );
      if (answer.json().autoFollowup) {
        await consumeAgentEvents(answer.json().autoFollowup.eventsUrl, cookie);
      }
    }
    const dynamic = await api(
      "POST",
      "/api/member/interview/messages",
      cookie,
      {
        clientMessageId: randomUUID(),
        content: "遇到重要分歧时，我希望先理解彼此，再共同决定。",
      },
      202,
    );
    await consumeAgentEvents(dynamic.json().eventsUrl, cookie);
  }

  async function publishPortrait(cookie: string) {
    const worker = await createPortraitWorker({
      databaseUrl,
      now: () => now,
      agentModel: {
        provider: "deterministic-fake",
        model: "acceptance-worker-v1",
        reply: matchingReply,
      },
    });
    const submitted = await api(
      "POST",
      "/api/member/portrait/versions",
      cookie,
      { clientRequestId: randomUUID() },
      202,
    );
    expect(submitted.json().status).toBe("generating");
    await worker.drain();
    await worker.close();

    let portrait = (await api("GET", "/api/member/portrait", cookie)).json();
    expect(portrait.calibration.scenarios).toHaveLength(10);
    for (const scenario of portrait.calibration.scenarios) {
      portrait = (
        await api(
          "POST",
          `/api/member/portrait/calibration/${scenario.id}`,
          cookie,
          { rating: "like", correction: "", criticalFabrication: false },
        )
      ).json();
    }
    expect(portrait.calibration).toMatchObject({
      answered: 10,
      likeCount: 10,
      canPublish: true,
    });
    const published = await api("POST", "/api/member/portrait/publish", cookie, {
      versionId: portrait.submittedVersion.id,
    });
    expect(published.json().status).toBe("published");
  }

  async function chatWithCandidateTwin(
    cookie: string,
    openUrl: string,
    content: string,
  ) {
    const opened = await api("POST", openUrl, cookie, {
      consentToOwnerVisibility: true,
    }, 201);
    const conversationId = opened.json().conversationId as string;
    const sent = await api(
      "POST",
      `/api/member/candidate-twin-conversations/${conversationId}/messages`,
      cookie,
      { clientMessageId: randomUUID(), content },
      202,
    );
    await consumeAgentEvents(sent.json().eventsUrl, cookie);
    return (
      await api(
        "GET",
        `/api/member/candidate-twin-conversations/${conversationId}`,
        cookie,
      )
    ).json();
  }

  beforeAll(async () => {
    const migrationApp = await createApp({
      databaseUrl,
      mailer: new MemoryMailer(),
      otpSecret: "acceptance-test-secret",
      superAdminEmail: "owner@onlylove.test",
    });
    await migrationApp.close();
  });

  beforeEach(async () => {
    if (app) await app.close();
    const pool = new Pool({ connectionString: databaseUrl });
    await pool.query("TRUNCATE sessions, otp_challenges, invitations, members CASCADE");
    await pool.end();
    now = new Date("2026-08-23T08:00:00.000Z");
    mailer = new MemoryMailer();
    app = await createApp({
      databaseUrl,
      mailer,
      otpSecret: "acceptance-test-secret",
      superAdminEmail: "owner@onlylove.test",
      now: () => now,
      agentModel: {
        provider: "deterministic-fake",
        model: "acceptance-conversation-v1",
        reply: "我是 AI 恋爱分身。我会先听完彼此的考虑，再一起讨论决定。",
        extractReply: portraitReply,
      },
      connectionMaintenanceIntervalMs: 60_000,
    });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("completes registration, matching, contact, relationship, governance, and deletion", async () => {
    await api("GET", "/api/health");
    const ownerCookie = await signIn("owner@onlylove.test");
    await api("PUT", "/api/admin/matching-settings", ownerCookie, {
      candidateCapacity: 2,
      minimumReciprocalScore: 0,
    });
    await api("PUT", "/api/admin/agent-quota-settings", ownerCookie, {
      ownAgentDailyLimit: 100,
      candidateTwinDailyLimit: 50,
    });
    await api("POST", "/api/admin/administrators", ownerCookie, {
      email: "operator@onlylove.test",
    }, 201);
    const operatorCookie = await signIn("operator@onlylove.test");
    expect(
      (await api("GET", "/api/admin/dashboard", operatorCookie, undefined, 403)).json(),
    ).toEqual({ code: "FORBIDDEN" });

    const members = [
      {
        email: "linxia@onlylove.test",
        nickname: "林夏",
        birthDate: "1992-04-12",
        gender: "female",
        heightCm: 165,
        occupation: "产品设计师",
      },
      {
        email: "beichuan@onlylove.test",
        nickname: "北川",
        birthDate: "1990-03-02",
        gender: "male",
        heightCm: 178,
        occupation: "工程师",
      },
    ] as const;
    const cookies = new Map<string, string>();
    for (const member of members) {
      await api("POST", "/api/admin/invitations", ownerCookie, {
        email: member.email,
      }, 201);
      const cookie = await signIn(member.email, member.birthDate);
      cookies.set(member.email, cookie);
      await api("PUT", "/api/member/profile", cookie, {
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
      });
      await completeInterview(cookie);
      await publishPortrait(cookie);
    }

    const linxiaCookie = cookies.get("linxia@onlylove.test")!;
    const beichuanCookie = cookies.get("beichuan@onlylove.test")!;
    await api("POST", "/api/member/recommendations", linxiaCookie, undefined, 202);
    const matchingWorker = await createPortraitWorker({
      databaseUrl,
      now: () => now,
      agentModel: {
        provider: "deterministic-fake",
        model: "acceptance-matching-v1",
        reply: matchingReply,
      },
    });
    await matchingWorker.drain();
    await matchingWorker.close();
    const recommendationState = await api(
      "GET",
      "/api/member/recommendations",
      linxiaCookie,
    );
    expect(recommendationState.json().candidates).toEqual([
      expect.objectContaining({
        nickname: "北川",
        reason: expect.not.stringMatching(/分数|标签|evidence|aToB|bToA/i),
      }),
    ]);
    const recommendationId = recommendationState.json().candidates[0].id;

    const linxiaTwinChat = await chatWithCandidateTwin(
      linxiaCookie,
      `/api/member/recommendations/${recommendationId}/twin-conversation`,
      "如果长期计划变化，你会怎样和伴侣决定？",
    );
    const twinAnswer = linxiaTwinChat.messages.find(
      ({ role }: { role: string }) => role === "agent",
    );
    expect(twinAnswer.content).toContain("AI 恋爱分身");
    const request = await api(
      "POST",
      `/api/member/recommendations/${recommendationId}/contact-request`,
      linxiaCookie,
      undefined,
      201,
    );
    const requestId = request.json().id as string;
    const inbox = await api("GET", "/api/member/contact-requests", beichuanCookie);
    expect(inbox.json().incoming[0]).toMatchObject({
      id: requestId,
      candidate: { nickname: "林夏" },
    });
    await chatWithCandidateTwin(
      beichuanCookie,
      `/api/member/contact-requests/${requestId}/twin-conversation`,
      "你希望怎样处理两个人的重大分歧？",
    );

    const accepted = await api(
      "POST",
      `/api/member/contact-requests/${requestId}/accept`,
      beichuanCookie,
    );
    const connectionId = accepted.json().connection.id as string;
    const currentForLinxia = await api(
      "GET",
      "/api/member/contact-requests",
      linxiaCookie,
    );
    expect(currentForLinxia.json().currentConnection.id).toBe(connectionId);
    const conversationId = currentForLinxia.json().currentConnection.conversation
      .id as string;
    const humanMessage = await api(
      "POST",
      `/api/member/human-conversations/${conversationId}/messages`,
      beichuanCookie,
      {
        clientMessageId: randomUUID(),
        content: "我们先聊聊未来两年的生活安排。",
      },
      201,
    );

    now = new Date(now.getTime() + 8 * 86_400_000);
    for (const cookie of [linxiaCookie, beichuanCookie]) {
      const continued = await api(
        "POST",
        `/api/member/connections/${connectionId}/followup`,
        cookie,
        { decision: "continue" },
      );
      expect(continued.json().currentConnection.followup.myDecision).toBe(
        "continue",
      );
    }
    await api(
      "POST",
      `/api/member/connections/${connectionId}/followup`,
      linxiaCookie,
      { decision: "confirm" },
    );
    const confirmed = await api(
      "POST",
      `/api/member/connections/${connectionId}/followup`,
      beichuanCookie,
      { decision: "confirm" },
    );
    expect(confirmed.json().currentConnection.relationshipStatus).toBe("confirmed");

    await api("POST", "/api/member/distortion-feedback", linxiaCookie, {
      messageId: twinAnswer.id,
      details: "这个回答没有体现主人曾经表达的不确定性。",
    }, 201);
    const report = await api("POST", "/api/member/reports", linxiaCookie, {
      targetKind: "human_message",
      targetId: humanMessage.json().message.id,
      reason: "需要管理员复核这条真人消息。",
      evidence: "请结合本次联系的上下文判断。",
      block: false,
    }, 201);
    const caseId = report.json().case.id as string;
    await api("GET", `/api/admin/moderation-cases/${caseId}`, operatorCookie);
    await api(
      "POST",
      `/api/admin/moderation-cases/${caseId}/decision`,
      operatorCookie,
      { action: "warning", reason: "消息表达需要更尊重对方边界。" },
    );
    const appeal = await api(
      "POST",
      `/api/member/moderation-cases/${caseId}/appeal`,
      beichuanCookie,
      { reason: "申请复核完整语境。", evidence: "双方正在讨论共同计划。" },
      201,
    );
    await api(
      "POST",
      `/api/admin/moderation-cases/${appeal.json().case.id}/decision`,
      operatorCookie,
      { action: "dismissed", reason: "复核后不追加处置。" },
    );
    await api("POST", "/api/member/blocks", linxiaCookie, {
      targetKind: "connection",
      targetId: connectionId,
    }, 201);
    expect(
      (await api("GET", "/api/member/contact-requests", linxiaCookie)).json()
        .currentConnection,
    ).toBeNull();

    await api("DELETE", "/api/member", beichuanCookie, undefined, 204);
    const retainedHistory = await api(
      "GET",
      `/api/member/human-conversations/${conversationId}`,
      linxiaCookie,
    );
    expect(retainedHistory.json()).toMatchObject({
      canSend: false,
      otherMember: {
        displayName: "已注销成员（历史消息已保留）",
        deleted: true,
      },
      messages: [expect.objectContaining({ content: "我们先聊聊未来两年的生活安排。" })],
    });

    expect((await api("GET", "/api/admin/agent-runs", operatorCookie)).json()).toEqual({
      runs: [],
    });
    const dashboard = await api("GET", "/api/admin/dashboard", ownerCookie);
    expect(dashboard.json()).toMatchObject({
      members: { registered: 2, published: 2 },
      recommendations: { generated: 1 },
      contacts: { accepted: 1, current: 0, ended: 1 },
      quality: { criticalFabrications: 0, distortionFeedback: 1 },
    });
    const observability = await api(
      "GET",
      "/api/admin/agent-observability",
      ownerCookie,
    );
    expect(observability.json()).toMatchObject({
      summary: {
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
        estimatedCostCny: expect.any(Number),
        averageLatencyMs: expect.any(Number),
      },
      groups: expect.arrayContaining([
        expect.objectContaining({ provider: "deterministic-fake" }),
      ]),
    });
    expect(
      (await api("GET", "/api/admin/agent-runtime", ownerCookie)).json()
        .definitions,
    ).toHaveLength(4);
    expect((await api("GET", "/api/admin/audits", ownerCookie)).json().audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "administrator_created" }),
        expect.objectContaining({ action: "matching_settings_updated" }),
        expect.objectContaining({ action: "agent_quota_settings_updated" }),
      ]),
    );
  });
});
