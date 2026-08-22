import { mount } from "@vue/test-utils";
import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import App from "./App.vue";
import { routes } from "./router.js";

describe("OnlyLove UI seam", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows the mobile password sign-in flow", async () => {
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push("/login");
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });

    expect(wrapper.text()).toContain("认真了解，再决定靠近");
    expect(wrapper.get('input[type="email"]').attributes("autocomplete")).toBe(
      "email",
    );
    expect(wrapper.get('input[type="password"]').attributes("autocomplete")).toBe(
      "current-password",
    );
    expect(wrapper.get('button[type="submit"]').text()).toContain("登录");
    expect(wrapper.text()).toContain("首次登录或忘记密码");
  });

  it("logs in with an existing password", async () => {
    const request = vi.fn(async (url: string) => {
      if (url === "/api/auth/login") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "member@example.com", role: "member" },
            requiresPasswordSetup: false,
          }),
        };
      }
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "member@example.com", role: "member" },
            requiresPasswordSetup: false,
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          profile: {
            nickname: "",
            birthDate: "1990-01-01",
            gender: "",
            heightCm: null,
            city: "",
            occupation: "",
          },
          matchCriteria: null,
        }),
      };
    });
    vi.stubGlobal("fetch", request);
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push("/login");
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });

    await wrapper.get('input[type="email"]').setValue("member@example.com");
    await wrapper.get('input[type="password"]').setValue("secure password");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(request).toHaveBeenCalledWith(
      "/api/auth/login",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"password":"secure password"'),
      }),
    );
    expect(router.currentRoute.value.fullPath).toBe("/app");
  });

  it("sends an ordinary administrator to the case review workspace", async () => {
    const request = vi.fn(async (url: string) => {
      if (url === "/api/auth/login" || url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "moderator@example.com", role: "admin" },
            requiresPasswordSetup: false,
          }),
        };
      }
      if (url === "/api/admin/moderation-cases") {
        return { ok: true, status: 200, json: async () => ({ cases: [] }) };
      }
      if (url === "/api/admin/moderation-metrics") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ distortionFeedbackCount: 0, openCaseCount: 0 }),
        };
      }
      if (url === "/api/admin/invitations") {
        return { ok: true, status: 200, json: async () => ({ invitations: [] }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", request);
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push("/login");
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });

    await wrapper.get('input[type="email"]').setValue("moderator@example.com");
    await wrapper.get('input[type="password"]').setValue("secure password");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(router.currentRoute.value.fullPath).toBe("/admin");
    expect(wrapper.text()).toContain("审核工作台");
    expect(request).toHaveBeenCalledWith("/api/admin/invitations");
  });

  it("uses an email code to require password setup for a new member", async () => {
    let passwordSet = false;
    const request = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/auth/otp") {
        return {
        ok: true,
        status: 202,
        json: async () => ({
          challengeId: "1dc8b163-2270-42b6-a90a-dbb3b887501e",
          requiresBirthDate: true,
        }),
        };
      }
      if (url === "/api/auth/verify") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "member@example.com", role: "member" },
            requiresPasswordSetup: true,
          }),
        };
      }
      if (url === "/api/auth/password" && options?.method === "PUT") {
        passwordSet = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "member@example.com", role: "member" },
            requiresPasswordSetup: false,
          }),
        };
      }
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "member@example.com", role: "member" },
            requiresPasswordSetup: !passwordSet,
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          profile: {
            nickname: "",
            birthDate: "1990-01-01",
            gender: "",
            heightCm: null,
            city: "",
            occupation: "",
          },
          matchCriteria: null,
        }),
      };
    });
    vi.stubGlobal("fetch", request);
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push("/login");
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });

    const recovery = wrapper
      .findAll("button")
      .find((button) => button.text().includes("首次登录或忘记密码"))!;
    await recovery.trigger("click");
    await wrapper.get('input[type="email"]').setValue("member@example.com");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(request).toHaveBeenCalledWith(
      "/api/auth/otp",
      expect.objectContaining({ method: "POST" }),
    );
    expect(wrapper.text()).toContain("输入六位验证码");
    expect(wrapper.get('input[autocomplete="one-time-code"]')).toBeTruthy();
    expect(wrapper.get('input[type="date"]')).toBeTruthy();

    await wrapper.get('input[autocomplete="one-time-code"]').setValue("123456");
    await wrapper.get('input[type="date"]').setValue("1990-01-01");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(request).toHaveBeenCalledWith(
      "/api/auth/verify",
      expect.objectContaining({
        body: expect.stringContaining('"birthDate":"1990-01-01"'),
      }),
    );
    expect(router.currentRoute.value.path).toBe("/set-password");

    await wrapper.get("#new-password").setValue("secure password");
    await wrapper.get("#confirm-password").setValue("secure password");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(request).toHaveBeenCalledWith(
      "/api/auth/password",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining('"password":"secure password"'),
      }),
    );
    expect(router.currentRoute.value.fullPath).toBe("/app");
  });

  it("redirects an existing passwordless session to password setup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          member: { email: "legacy@example.com", role: "member" },
          requiresPasswordSetup: true,
        }),
      })),
    );
    const router = createRouter({ history: createMemoryHistory(), routes });
    const wrapper = mount(App, { global: { plugins: [router] } });
    await router.push("/app");
    await router.isReady();
    await flushPromises();

    expect(router.currentRoute.value.path).toBe("/set-password");
    expect(wrapper.text()).toContain("设置登录密码");
  });

  it("shows the member shell with the four agreed destinations", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        member: { email: "member@example.com", role: "member" },
      }),
    });
    vi.stubGlobal("fetch", request);
    const router = createRouter({ history: createMemoryHistory(), routes });
    const wrapper = mount(App, { global: { plugins: [router] } });
    await router.isReady();
    await router.push("/app");
    await flushPromises();
    expect(request).toHaveBeenCalledWith("/api/session");
    expect(router.currentRoute.value.fullPath).toBe("/app");

    expect(wrapper.text()).toContain("我的恋爱分身");
    for (const label of ["我的分身", "候选推荐", "联系", "我的"]) {
      expect(wrapper.get("nav").text()).toContain(label);
    }
    expect(wrapper.findAll("nav button")).toHaveLength(4);
    const passwordAction = wrapper
      .findAll("a")
      .find((link) => link.text().includes("设置或重置密码"))!;
    expect(passwordAction.exists()).toBe(true);
    await passwordAction.trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/login");
    expect(wrapper.get('button[type="submit"]').text()).toContain("获取验证码");
  });

  it("confirms logical account deletion from My and returns to sign in", async () => {
    const request = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "member@example.com", role: "member" },
          }),
        };
      }
      if (url === "/api/member/profile") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ profile: null, matchCriteria: null }),
        };
      }
      if (url === "/api/member" && options?.method === "DELETE") {
        return { ok: true, status: 204 };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", request);
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push("/app");
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.text()).toContain("注销账户");
    await wrapper.get("button.delete-account").trigger("click");
    await flushPromises();

    expect(request).toHaveBeenCalledWith("/api/member", { method: "DELETE" });
    expect(router.currentRoute.value.path).toBe("/login");
  });

  it("shows the independent invitation-management entry to a super administrator", async () => {
    const original = {
      id: "1dc8b163-2270-42b6-a90a-dbb3b887501e",
      email: "invited@example.com",
      status: "active",
      expiresAt: "2026-08-27T08:00:00.000Z",
    };
    let invitationState = [original];
    const request = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "admin@example.com", role: "super_admin" },
          }),
        };
      }
      if (options?.method === "POST" && url.endsWith("/reissue")) {
        invitationState = [
          {
            ...original,
            id: "f52654ef-daad-46f6-8860-e27a867b17d4",
            expiresAt: "2026-09-03T08:00:00.000Z",
          },
          { ...original, status: "revoked" },
        ];
        return { ok: true, status: 201, json: async () => invitationState[0] };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ invitations: invitationState }),
      };
    });
    vi.stubGlobal("fetch", request);
    const router = createRouter({ history: createMemoryHistory(), routes });
    const wrapper = mount(App, { global: { plugins: [router] } });
    await router.isReady();
    await router.push("/admin");
    await flushPromises();

    expect(wrapper.text()).toContain("管理后台");
    expect(wrapper.get('input[type="email"]')).toBeTruthy();
    expect(wrapper.text()).toContain("invited@example.com");
    expect(wrapper.get("button.invitation-action").text()).toContain("撤销");

    const reissue = wrapper
      .findAll("button.invitation-action")
      .find((button) => button.text().includes("重新签发"))!;
    await reissue.trigger("click");
    await flushPromises();
    expect(request).toHaveBeenCalledWith(
      `/api/admin/invitations/${original.id}/reissue`,
      { method: "POST" },
    );
    expect(wrapper.findAll(".invitation-list article")).toHaveLength(2);
    expect(wrapper.text()).toContain("已撤销");
  });

  it("lets a super administrator restore a logically deleted member", async () => {
    const deletedMember = {
      id: "1dc8b163-2270-42b6-a90a-dbb3b887501e",
      email: "deleted@example.com",
      nickname: "已离开的人",
      deletedAt: "2026-08-22T08:00:00.000Z",
    };
    let deletedMemberLoads = 0;
    const request = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "admin@example.com", role: "super_admin" },
          }),
        };
      }
      if (url === `/api/admin/deleted-members/${deletedMember.id}/restore`) {
        return { ok: true, status: 200, json: async () => deletedMember };
      }
      if (url === "/api/admin/deleted-members") {
        deletedMemberLoads += 1;
        if (deletedMemberLoads > 1) throw new Error("list reload unavailable");
        return {
          ok: true,
          status: 200,
          json: async () => ({ members: [deletedMember] }),
        };
      }
      if (url === "/api/admin/invitations") {
        return { ok: true, status: 200, json: async () => ({ invitations: [] }) };
      }
      if (url === "/api/admin/moderation-cases") {
        return { ok: true, status: 200, json: async () => ({ cases: [] }) };
      }
      if (url === "/api/admin/moderation-metrics") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ distortionFeedbackCount: 0, openCaseCount: 0 }),
        };
      }
      if (url === "/api/admin/matching-settings") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ candidateCapacity: 5, minimumReciprocalScore: 60 }),
        };
      }
      if (url === "/api/admin/agent-quota-settings") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ownAgentDailyLimit: 100, candidateTwinDailyLimit: 50 }),
        };
      }
      if (url === "/api/admin/relationship-metrics") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            dueConnections: 0,
            mutualContinue: 0,
            noFeedback: 0,
            ended: 0,
            confirmed: 0,
            recoveryPending: 0,
            resumed: 0,
            mutualContinueRate: 0,
          }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", request);
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push("/admin");
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.text()).toContain("已注销成员");
    expect(wrapper.text()).toContain("deleted@example.com");
    expect(wrapper.text()).toContain("永久清除");
    const restore = wrapper
      .findAll("button")
      .find((button) => button.text() === "恢复")!;
    await restore.trigger("click");
    await flushPromises();

    expect(request).toHaveBeenCalledWith(
      `/api/admin/deleted-members/${deletedMember.id}/restore`,
      { method: "POST" },
    );
    expect(wrapper.text()).toContain("成员已恢复");
    expect(wrapper.text()).not.toContain("deleted@example.com");
  });

  it("validates, saves, and edits a member profile and match criteria", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-02-29T12:00:00"));
    let version = 0;
    let saveFailsWithHtml = false;
    let storedProfile: {
      profile: object;
      matchCriteria: object | null;
    } = {
      profile: {
        nickname: "",
        birthDate: "1990-01-01",
        gender: "",
        heightCm: null,
        city: "",
        occupation: "",
      },
      matchCriteria: null,
    };
    const request = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "member@example.com", role: "member" },
          }),
        };
      }
      if (options?.method === "PUT") {
        if (saveFailsWithHtml) {
          return {
            ok: false,
            status: 502,
            json: async () => {
              throw new SyntaxError("Unexpected token '<'");
            },
          };
        }
        version += 1;
        const body = JSON.parse(String(options.body));
        storedProfile = {
          ...body,
          matchCriteria: { ...body.matchCriteria, version },
        };
        return {
          ok: true,
          status: 200,
          json: async () => storedProfile,
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => storedProfile,
      };
    });
    vi.stubGlobal("fetch", request);
    const router = createRouter({ history: createMemoryHistory(), routes });
    const wrapper = mount(App, { global: { plugins: [router] } });
    await router.push("/app");
    await router.isReady();
    await flushPromises();
    expect(wrapper.get("#profile-birth-date").attributes("max")).toBe(
      "2006-02-28",
    );

    await wrapper.get("#nickname").setValue("林夏");
    await wrapper.get("#profile-birth-date").setValue("1990-04-12");
    await wrapper.get("#gender").setValue("female");
    await wrapper.get("#height-cm").setValue("165");
    await wrapper.get("#city").setValue("上海");
    await wrapper.get("#occupation").setValue("产品设计师");
    await wrapper.get("#desired-gender").setValue("female");
    await wrapper.get("#acceptable-cities").setValue("上海、杭州");

    await wrapper.get("form.profile-form").trigger("submit");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("异性");

    await wrapper.get("#desired-gender").setValue("male");
    await wrapper.get("#age-unlimited").setValue(false);
    await wrapper.get("#age-minimum").setValue("28");
    await wrapper.get("#age-maximum").setValue("38");
    await wrapper.get("#age-mode").setValue("required");
    await wrapper.get("#occupation-unlimited").setValue(false);
    await wrapper
      .get("#occupation-requirement")
      .setValue("稳定的专业工作");
    await wrapper.get("#occupation-mode").setValue("preferred");
    await wrapper.get("form.profile-form").trigger("submit");
    await flushPromises();

    expect(request).toHaveBeenCalledWith(
      "/api/member/profile",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining('"acceptableCities":["上海","杭州"]'),
      }),
    );
    expect(wrapper.get('[role="status"]').text()).toContain("v1");

    await router.push("/login");
    await router.push("/app");
    await flushPromises();
    expect(wrapper.get<HTMLInputElement>("#nickname").element.value).toBe(
      "林夏",
    );
    expect(wrapper.get<HTMLInputElement>("#age-minimum").element.value).toBe(
      "28",
    );
    expect(
      wrapper.get<HTMLInputElement>("#acceptable-cities").element.value,
    ).toBe("上海、杭州");

    await wrapper.get("#nickname").setValue("林夏夏");
    await wrapper.get("form.profile-form").trigger("submit");
    await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toContain("v2");

    saveFailsWithHtml = true;
    await wrapper.get("form.profile-form").trigger("submit");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe(
      "资料未保存，请检查填写内容。",
    );
  });

  it("keeps the profile form hidden until a failed load is retried", async () => {
    let profileAttempts = 0;
    const request = vi.fn(async (url: string) => {
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "member@example.com", role: "member" },
          }),
        };
      }
      profileAttempts += 1;
      if (profileAttempts === 1) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          profile: {
            nickname: "已保存成员",
            birthDate: "1990-01-01",
            gender: "female",
            heightCm: 165,
            city: "上海",
            occupation: "设计师",
          },
          matchCriteria: null,
        }),
      };
    });
    vi.stubGlobal("fetch", request);
    const router = createRouter({ history: createMemoryHistory(), routes });
    const wrapper = mount(App, { global: { plugins: [router] } });
    await router.push("/app");
    await router.isReady();
    await flushPromises();

    expect(wrapper.find("form.profile-form").exists()).toBe(false);
    expect(wrapper.get('[role="alert"]').text()).toContain("无法读取资料");
    await wrapper.get("button.load-retry").trigger("click");
    await flushPromises();

    expect(wrapper.get<HTMLInputElement>("#nickname").element.value).toBe(
      "已保存成员",
    );
  });

  it("completes the fixed interview before opening dynamic chat", async () => {
    class FakeEventSource {
      static current: FakeEventSource;
      readonly listeners = new Map<string, (event: MessageEvent) => void>();

      constructor(readonly url: string) {
        FakeEventSource.current = this;
      }

      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(type, listener);
      }

      close() {}

      emit(type: string, data: object) {
        this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const request = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "member@example.com", role: "member" },
          }),
        };
      }
      if (url === "/api/member/profile") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ profile: {}, matchCriteria: null }),
        };
      }
      if (
        url === "/api/member/portrait/interview/fixed-answers" &&
        options?.method === "POST"
      ) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            fixedInterview: {
              answered: 10,
              total: 10,
              completed: true,
              question: null,
            },
            progress: { completed: 0, total: 8 },
            autoFollowup: {
              jobId: "9b1d8d72-bd60-41b2-8ad8-d2cfd0e84e2f",
              eventsUrl:
                "/api/member/interview/jobs/9b1d8d72-bd60-41b2-8ad8-d2cfd0e84e2f/events",
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          conversationId: null,
          messages: [],
          fixedInterview: {
            answered: 9,
            total: 10,
            completed: false,
            question: {
              id: "shared-future-cost",
              number: 10,
              prompt: "共同未来需要牺牲当下时，你会怎么衡量？",
              options: [
                { id: "accept-cost", text: "愿意承受一段时间的不方便" },
                { id: "protect-now", text: "优先保护现在的生活质量" },
                { id: "small-trial", text: "先做小规模尝试" },
                { id: "agree-then-stop", text: "答应后也可能中途改变" },
              ],
            },
          },
          progress: { completed: 0, total: 8 },
        }),
      };
    });
    vi.stubGlobal("fetch", request);
    const router = createRouter({ history: createMemoryHistory(), routes });
    const wrapper = mount(App, { global: { plugins: [router] } });
    await router.push("/app");
    await router.isReady();
    await flushPromises();
    await wrapper
      .findAll("nav button")
      .find((button) => button.text().includes("我的分身"))!
      .trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("固定访谈");
    expect(wrapper.text()).toContain("10/10");
    expect(wrapper.find("form.interview-composer").exists()).toBe(false);
    await wrapper.get('.fixed-option input[value="accept-cost"]').setValue(true);
    await wrapper.get(".fixed-supplement textarea").setValue("会先约定复盘时间。");
    await wrapper.get(".fixed-interview-panel form").trigger("submit");
    await flushPromises();

    expect(request).toHaveBeenCalledWith(
      "/api/member/portrait/interview/fixed-answers",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"selectedOptionIds":["accept-cost"]'),
      }),
    );
    expect(wrapper.find("form.interview-composer").exists()).toBe(true);
    expect(wrapper.text()).toContain("0/8");
    expect(FakeEventSource.current.url).toContain("/events");
    FakeEventSource.current.emit("delta", {
      text: "哪一次具体经历最能说明你的取舍？",
    });
    await flushPromises();
    expect(wrapper.text()).toContain("哪一次具体经历最能说明你的取舍？");
  });

  it("sends the first interview message and renders the streamed Agent answer", async () => {
    class FakeEventSource {
      static current: FakeEventSource;
      readonly listeners = new Map<string, (event: MessageEvent) => void>();
      readonly url: string;

      constructor(url: string) {
        this.url = url;
        FakeEventSource.current = this;
      }

      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(type, listener);
      }

      close() {}

      emit(type: string, data: object) {
        this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("crypto", {
      randomUUID: () => "e49f9560-17f8-4929-8da8-554a93d25b31",
    });
    const request = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "member@example.com", role: "member" },
          }),
        };
      }
      if (url === "/api/member/profile") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profile: {
              nickname: "林夏",
              birthDate: "1990-01-01",
              gender: "female",
              heightCm: 165,
              city: "上海",
              occupation: "设计师",
            },
            matchCriteria: null,
          }),
        };
      }
      if (options?.method === "POST") {
        return {
          ok: true,
          status: 202,
          json: async () => ({
            conversationId: "55b584a9-dcfa-479f-baf7-fc8a285b255d",
            jobId: "d762e0e4-8ca1-4fd8-a2a4-e219fef3a6de",
            eventsUrl:
              "/api/member/interview/jobs/d762e0e4-8ca1-4fd8-a2a4-e219fef3a6de/events",
            quotaRemaining: 99,
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ conversationId: null, messages: [] }),
      };
    });
    vi.stubGlobal("fetch", request);
    const router = createRouter({ history: createMemoryHistory(), routes });
    const wrapper = mount(App, { global: { plugins: [router] } });
    await router.push("/app");
    await router.isReady();
    await flushPromises();

    const twinTab = wrapper
      .findAll("nav button")
      .find((button) => button.text().includes("我的分身"))!;
    await twinTab.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("私有画像访谈员");
    expect(wrapper.text()).toContain("AI");

    await wrapper
      .get("textarea")
      .setValue("我在冲突时通常需要先冷静一下。");
    await wrapper.get("form.interview-composer").trigger("submit");
    await flushPromises();
    expect(request).toHaveBeenCalledWith(
      "/api/member/interview/messages",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("我在冲突时通常需要先冷静一下。"),
      }),
    );
    expect(FakeEventSource.current.url).toContain("/events");

    FakeEventSource.current.emit("delta", {
      text: "什么信号会让你愿意重新开始沟通？",
    });
    await flushPromises();
    expect(wrapper.text()).toContain("什么信号会让你愿意重新开始沟通？");
    FakeEventSource.current.emit("done", {});
    await flushPromises();
    expect(wrapper.text()).toContain("什么信号会让你愿意重新开始沟通？");
    expect(wrapper.text()).toContain("今日还可发送 99 条");
  });

  it("reconnects SSE transport errors and restores a draft when POST fails", async () => {
    class FakeEventSource {
      static current: FakeEventSource;
      readonly listeners = new Map<string, (event: Event) => void>();
      close = vi.fn();

      constructor(readonly url: string) {
        FakeEventSource.current = this;
      }

      addEventListener(type: string, listener: (event: Event) => void) {
        this.listeners.set(type, listener);
      }

      emit(event: Event) {
        this.listeners.get(event.type)?.(event);
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const ids = [
      "b073ec9c-5c78-4cc1-b109-8720c4d977e8",
      "f963e260-60fd-4fb4-83d6-98b44df9bd9a",
    ];
    vi.stubGlobal("crypto", { randomUUID: () => ids.shift()! });
    let postCount = 0;
    const request = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "member@example.com", role: "member" },
          }),
        };
      }
      if (url === "/api/member/profile") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profile: {
              nickname: "林夏",
              birthDate: "1990-01-01",
              gender: "female",
              heightCm: 165,
              city: "上海",
              occupation: "设计师",
            },
            matchCriteria: null,
          }),
        };
      }
      if (options?.method === "POST") {
        postCount += 1;
        if (postCount === 2) throw new TypeError("network unavailable");
        return {
          ok: true,
          status: 202,
          json: async () => ({
            eventsUrl: "/api/member/interview/jobs/job/events",
            quotaRemaining: 99,
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ conversationId: null, messages: [] }),
      };
    });
    vi.stubGlobal("fetch", request);
    const router = createRouter({ history: createMemoryHistory(), routes });
    const wrapper = mount(App, { global: { plugins: [router] } });
    await router.push("/app");
    await router.isReady();
    await flushPromises();
    await wrapper
      .findAll("nav button")
      .find((button) => button.text().includes("我的分身"))!
      .trigger("click");
    await flushPromises();

    await wrapper.get("textarea").setValue("第一条会被流式处理。");
    await wrapper.get("form.interview-composer").trigger("submit");
    await flushPromises();
    FakeEventSource.current.emit(new Event("error"));
    await flushPromises();

    expect(FakeEventSource.current.close).not.toHaveBeenCalled();
    expect(wrapper.get<HTMLTextAreaElement>("textarea").element.disabled).toBe(
      true,
    );

    FakeEventSource.current.emit(
      new MessageEvent("error", {
        data: JSON.stringify({ code: "MODEL_REQUEST_FAILED" }),
      }),
    );
    await flushPromises();
    await wrapper.get("textarea").setValue("第二条发送失败后要恢复。");
    await wrapper.get("form.interview-composer").trigger("submit");
    await flushPromises();

    expect(wrapper.get<HTMLTextAreaElement>("textarea").element.value).toBe(
      "第二条发送失败后要恢复。",
    );
    expect(wrapper.text()).not.toContain("第二条发送失败后要恢复。");
  });

  it("submits the portrait and collects focused calibration feedback", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("crypto", {
      randomUUID: () => "a76d2b06-7d47-4616-a8cd-6ceff86528ef",
    });
    const scenario = {
      id: "d9d4c6c7-ef3e-47de-bbf0-e0367ad67957",
      number: 1,
      kind: "single",
      prompt: "伴侣收到外地三年的理想工作机会，你会怎样一起决定？",
      prediction: "我可能会先讨论这件事对两个人长期计划的影响。",
      answer: null,
    };
    let portrait: any = {
      status: "draft",
      submittedVersion: null,
      publishedVersion: null,
    };
    const request = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "member@example.com", role: "member" },
          }),
        };
      }
      if (url === "/api/member/profile") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ profile: {}, matchCriteria: null }),
        };
      }
      if (url === "/api/member/interview") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            messages: [],
            fixedInterview: {
              answered: 10,
              total: 10,
              completed: true,
              question: null,
            },
            progress: { completed: 8, total: 8 },
          }),
        };
      }
      if (url === "/api/member/portrait" && !options?.method) {
        if (portrait.status === "generating") {
          portrait = {
            ...portrait,
            status: "calibrating",
            calibration: {
              ...portrait.calibration,
              scenarios: [scenario],
            },
          };
        }
        return { ok: true, status: 200, json: async () => portrait };
      }
      if (url === "/api/member/portrait/versions") {
        portrait = {
          status: "generating",
          submittedVersion: { id: "version-1", version: 1 },
          publishedVersion: null,
          calibration: {
            answered: 0,
            total: 10,
            likeCount: 0,
            criticalFabrication: false,
            canPublish: false,
            scenarios: [{ ...scenario, prediction: null }],
          },
        };
        return { ok: true, status: 201, json: async () => portrait };
      }
      if (url === `/api/member/portrait/calibration/${scenario.id}`) {
        portrait = {
          ...portrait,
          status: "needs_more_understanding",
          message: "分身还需要继续了解你",
          calibration: {
            ...portrait.calibration,
            answered: 10,
            likeCount: 7,
            criticalFabrication: true,
            scenarios: [{ ...scenario, answer: { rating: "partial" } }],
          },
        };
        return { ok: true, status: 200, json: async () => portrait };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", request);
    const router = createRouter({ history: createMemoryHistory(), routes });
    const wrapper = mount(App, { global: { plugins: [router] } });
    await router.push("/app");
    await router.isReady();
    await flushPromises();
    await wrapper
      .findAll("nav button")
      .find((button) => button.text().includes("我的分身"))!
      .trigger("click");
    await flushPromises();

    await wrapper.get("button.submit-portrait").trigger("click");
    await flushPromises();
    expect(request).toHaveBeenCalledWith(
      "/api/member/portrait/versions",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("a76d2b06-7d47-4616-a8cd-6ceff86528ef"),
      }),
    );
    expect(wrapper.text()).toContain("正在生成 10 道未见场景回答");
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(wrapper.text()).toContain(scenario.prompt);
    expect(wrapper.text()).toContain(scenario.prediction);
    expect(wrapper.text()).toContain("像我");
    expect(wrapper.text()).toContain("部分像我");
    expect(wrapper.text()).toContain("不像我");

    await wrapper.get('input[value="partial"]').setValue(true);
    await wrapper
      .get(".calibration-correction textarea")
      .setValue("我会先确认双方各自不能放弃的部分。");
    await wrapper.get('input[name="critical-fabrication"]').setValue(true);
    await wrapper.get("form.calibration-form").trigger("submit");
    await flushPromises();
    expect(request).toHaveBeenCalledWith(
      `/api/member/portrait/calibration/${scenario.id}`,
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining(
          '"correction":"我会先确认双方各自不能放弃的部分。"',
        ),
      }),
    );
    expect(wrapper.text()).toContain("分身还需要继续了解你");
  });

  it("keeps the old version visible while publishing and withdrawing the new one", async () => {
    const ready = {
      status: "ready_to_publish",
      submittedVersion: { id: "version-2", version: 2 },
      publishedVersion: { id: "version-1", version: 1 },
      calibration: {
        answered: 10,
        total: 10,
        likeCount: 8,
        criticalFabrication: false,
        canPublish: true,
        scenarios: [],
      },
    };
    let portrait: any = ready;
    const request = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "member@example.com", role: "member" },
          }),
        };
      }
      if (url === "/api/member/profile") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ profile: {}, matchCriteria: null }),
        };
      }
      if (url === "/api/member/interview") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            messages: [],
            fixedInterview: {
              answered: 10,
              total: 10,
              completed: true,
              question: null,
            },
            progress: { completed: 8, total: 8 },
          }),
        };
      }
      if (url === "/api/member/portrait" && !options?.method) {
        return { ok: true, status: 200, json: async () => portrait };
      }
      if (url === "/api/member/portrait/publish" && options?.method === "POST") {
        portrait = {
          ...ready,
          status: "published",
          publishedVersion: ready.submittedVersion,
        };
        return { ok: true, status: 200, json: async () => portrait };
      }
      if (url === "/api/member/portrait/publish" && options?.method === "DELETE") {
        portrait = { ...ready, publishedVersion: null };
        return { ok: true, status: 200, json: async () => portrait };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", request);
    const router = createRouter({ history: createMemoryHistory(), routes });
    const wrapper = mount(App, { global: { plugins: [router] } });
    await router.push("/app");
    await router.isReady();
    await flushPromises();
    await wrapper
      .findAll("nav button")
      .find((button) => button.text().includes("我的分身"))!
      .trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("已发布的 v1 继续服务");
    await wrapper.get("button.publish-portrait").trigger("click");
    await flushPromises();
    expect(request).toHaveBeenCalledWith(
      "/api/member/portrait/publish",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"versionId":"version-2"'),
      }),
    );
    expect(wrapper.text()).toContain("v2 已发布");

    await wrapper.get("button.withdraw-portrait").trigger("click");
    await flushPromises();
    expect(request).toHaveBeenCalledWith(
      "/api/member/portrait/publish",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(wrapper.text()).toContain("校准已通过，等待你主动发布");
  });

  it("switches the single twin entry from interviewer to the published AI twin", async () => {
    class FakeEventSource {
      static current: FakeEventSource;
      readonly listeners = new Map<string, (event: MessageEvent) => void>();

      constructor(readonly url: string) {
        FakeEventSource.current = this;
      }

      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(type, listener);
      }

      close() {}

      emit(type: string, data: object) {
        this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("crypto", {
      randomUUID: () => "44b6066a-85a4-4bd1-9fb5-d8feab8e4899",
    });
    const published = {
      id: "4b45d11e-b2b5-4140-bdb5-0ea1b60555ea",
      version: 1,
    };
    const request = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "member@example.com", role: "member" },
          }),
        };
      }
      if (url === "/api/member/profile") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ profile: {}, matchCriteria: null }),
        };
      }
      if (url === "/api/member/interview") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            messages: [],
            fixedInterview: {
              answered: 10,
              total: 10,
              completed: true,
              question: null,
            },
            progress: { completed: 8, total: 8 },
          }),
        };
      }
      if (url === "/api/member/portrait") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "published",
            submittedVersion: published,
            publishedVersion: published,
            calibration: {
              answered: 10,
              total: 10,
              likeCount: 10,
              criticalFabrication: false,
              canPublish: true,
              scenarios: [],
            },
          }),
        };
      }
      if (url === "/api/member/twin" && !options?.method) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            conversationId: null,
            profileVersion: published,
            messages: [],
          }),
        };
      }
      if (url === "/api/member/twin/messages" && options?.method === "POST") {
        return {
          ok: true,
          status: 202,
          json: async () => ({
            eventsUrl: "/api/member/twin/jobs/twin-job/events",
            quotaRemaining: 99,
          }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", request);
    const router = createRouter({ history: createMemoryHistory(), routes });
    const wrapper = mount(App, { global: { plugins: [router] } });
    await router.push("/app");
    await router.isReady();
    await flushPromises();
    await wrapper
      .findAll("nav button")
      .find((button) => button.text().includes("我的分身"))!
      .trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("私有画像访谈员");
    await wrapper.get('button[data-twin-role="twin"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("我的恋爱分身");
    expect(wrapper.text()).toContain("恋爱分身 · AI");
    expect(wrapper.text()).toContain("不会直接修改已发布版本");

    await wrapper
      .get(".twin-composer textarea")
      .setValue("这不像我，我会先约定重新沟通的时间。");
    await wrapper.get("form.twin-composer").trigger("submit");
    await flushPromises();
    expect(request).toHaveBeenCalledWith(
      "/api/member/twin/messages",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("这不像我"),
      }),
    );
    expect(FakeEventSource.current.url).toContain("/api/member/twin/jobs/");
    FakeEventSource.current.emit("delta", {
      text: "我是 AI 恋爱分身。我会先说明需要独处。",
    });
    FakeEventSource.current.emit("done", {});
    await flushPromises();
    expect(wrapper.text()).toContain("我是 AI 恋爱分身");
    expect(wrapper.text()).toContain("今日还可发送 99 条");
  });

  it("fetches, displays and skips safe candidate cards", async () => {
    let candidates = [
      {
        id: "recommendation-1",
        avatarText: "北",
        nickname: "北川",
        age: 36,
        heightCm: 178,
        city: "上海",
        occupation: "工程师",
        reason: "你们可以通过进一步交流，确认彼此在重要关系议题上的期待。",
      },
    ];
    let fetchedToday = false;
    const state = () => ({
      eligibility: { eligible: true, reasons: [] },
      capacity: 5,
      remainingCapacity: 5 - candidates.length,
      dailyFetchAvailable: !fetchedToday,
      candidates,
      followupQuestions: [],
    });
    const request = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "member@example.com", role: "member" },
          }),
        };
      }
      if (url === "/api/member/profile") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ profile: {}, matchCriteria: null }),
        };
      }
      if (url === "/api/member/recommendations" && options?.method === "POST") {
        fetchedToday = true;
        return { ok: true, status: 200, json: async () => state() };
      }
      if (url === "/api/member/recommendations") {
        return { ok: true, status: 200, json: async () => state() };
      }
      if (
        url === "/api/member/recommendations/recommendation-1/skip" &&
        options?.method === "POST"
      ) {
        candidates = [];
        return { ok: true, status: 204, json: async () => undefined };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", request);
    const router = createRouter({ history: createMemoryHistory(), routes });
    const wrapper = mount(App, { global: { plugins: [router] } });
    await router.push("/app");
    await router.isReady();
    await flushPromises();
    await wrapper
      .findAll("nav button")
      .find((button) => button.text().includes("候选推荐"))!
      .trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("北川");
    expect(wrapper.text()).toContain("36 岁 · 178 cm");
    expect(wrapper.text()).toContain("上海 · 工程师");
    expect(wrapper.get(".candidate-card").text()).not.toContain("member@example.com");
    await wrapper.get("button.fetch-recommendations").trigger("click");
    await flushPromises();
    expect(request).toHaveBeenCalledWith(
      "/api/member/recommendations",
      expect.objectContaining({ method: "POST" }),
    );
    await wrapper.get("button.skip-candidate").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("暂时没有达到条件的候选");
  });

  it("requires visibility consent, streams candidate twin chat and shows owner-only records", async () => {
    class FakeEventSource {
      static current: FakeEventSource;
      readonly listeners = new Map<string, (event: MessageEvent) => void>();

      constructor(readonly url: string) {
        FakeEventSource.current = this;
      }

      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(type, listener);
      }

      close() {}

      emit(type: string, data: object) {
        this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    let generatedMessageId = 0;
    vi.stubGlobal("crypto", {
      randomUUID: () =>
        `f6fd2b9f-71c9-4a69-99fe-${String(++generatedMessageId).padStart(12, "0")}`,
    });
    const candidate = {
      id: "4ac4601b-4694-4da7-bd75-07f4330c94d5",
      avatarText: "北",
      nickname: "北川",
      age: 36,
      heightCm: 178,
      city: "上海",
      occupation: "工程师",
      reason: "你们可以进一步了解。",
    };
    const candidateMessageStatuses = {
      CANDIDATE_TWIN_QUOTA_USED: 429,
      CANDIDATE_TWIN_IN_PROGRESS: 409,
      CANDIDATE_TWIN_UNAVAILABLE: 409,
      UNKNOWN_FAILURE: 500,
    } as const;
    let candidateMessageFailure:
      | keyof typeof candidateMessageStatuses
      | undefined;
    const request = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "member@example.com", role: "member" },
          }),
        };
      }
      if (url === "/api/member/profile") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ profile: {}, matchCriteria: null }),
        };
      }
      if (url === "/api/member/recommendations") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            eligibility: { eligible: true, reasons: [] },
            capacity: 5,
            remainingCapacity: 4,
            dailyFetchAvailable: false,
            candidates: [candidate],
            followupQuestions: [],
          }),
        };
      }
      if (
        url === `/api/member/recommendations/${candidate.id}/twin-conversation` &&
        options?.method === "POST"
      ) {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            conversationId: "ab93bbda-45a4-4479-bdc7-b21f629953d8",
            anonymousCode: "A1B2C3D4E5F6",
            profileVersion: { id: "version-1", version: 1 },
            candidate: {
              nickname: "北川",
              heightCm: 178,
              city: "上海",
              occupation: "工程师",
            },
            messages: [
              {
                id: "recovered-message",
                role: "member",
                content: "页面关闭前已发送的消息",
              },
            ],
            canReply: true,
            autoFollowup: {
              jobId: "recovered-job",
              eventsUrl: "/api/member/candidate-twin-jobs/recovered-job/events",
            },
          }),
        };
      }
      if (
        url ===
          "/api/member/candidate-twin-conversations/ab93bbda-45a4-4479-bdc7-b21f629953d8/messages" &&
        options?.method === "POST"
      ) {
        if (candidateMessageFailure) {
          return {
            ok: false,
            status: candidateMessageStatuses[candidateMessageFailure],
            json: async () => ({ code: candidateMessageFailure }),
          };
        }
        return {
          ok: true,
          status: 202,
          json: async () => ({
            eventsUrl: "/api/member/candidate-twin-jobs/job-1/events",
            quotaRemaining: 49,
          }),
        };
      }
      if (url === "/api/member/candidate-twin-conversations") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            conversations: [
              {
                conversationId: "owner-conversation-1",
                anonymousCode: "Z9Y8X7W6V5U4",
                profileVersion: { id: "version-1", version: 1 },
                canReply: false,
                messages: [
                  { id: "message-1", role: "member", content: "匿名访客原文" },
                  { id: "message-2", role: "agent", content: "我的分身回答" },
                ],
              },
            ],
          }),
        };
      }
      if (url === "/api/member/interview") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            messages: [],
            fixedInterview: {
              answered: 0,
              total: 10,
              completed: false,
              question: null,
            },
            progress: { completed: 0, total: 8 },
          }),
        };
      }
      if (url === "/api/member/portrait") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "draft",
            submittedVersion: null,
            publishedVersion: null,
          }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", request);
    const router = createRouter({ history: createMemoryHistory(), routes });
    const wrapper = mount(App, { global: { plugins: [router] } });
    await router.push("/app");
    await router.isReady();
    await flushPromises();

    await wrapper
      .findAll("nav button")
      .find((button) => button.text().includes("候选推荐"))!
      .trigger("click");
    await flushPromises();
    await wrapper.get("button.chat-candidate").trigger("click");
    expect(wrapper.text()).toContain("完整原文会提供给北川");
    expect(wrapper.get("button.open-candidate-twin").attributes("disabled")).toBeDefined();
    expect(request).not.toHaveBeenCalledWith(
      expect.stringContaining("twin-conversation"),
      expect.anything(),
    );

    await wrapper.get("#candidate-twin-consent").setValue(true);
    await wrapper.get("button.open-candidate-twin").trigger("click");
    await flushPromises();
    expect(request).toHaveBeenCalledWith(
      `/api/member/recommendations/${candidate.id}/twin-conversation`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ consentToOwnerVisibility: true }),
      }),
    );
    expect(wrapper.text()).toContain("北川的恋爱分身 · AI");
    expect(FakeEventSource.current.url).toBe(
      "/api/member/candidate-twin-jobs/recovered-job/events",
    );
    FakeEventSource.current.emit("delta", { text: "恢复后的 AI 回答。" });
    FakeEventSource.current.emit("done", {});
    await flushPromises();
    expect(wrapper.text()).toContain("恢复后的 AI 回答。");

    await wrapper.get(".candidate-twin-composer textarea").setValue("你怎么看冲突修复？");
    await wrapper.get("form.candidate-twin-composer").trigger("submit");
    await flushPromises();
    expect(FakeEventSource.current.url).toBe(
      "/api/member/candidate-twin-jobs/job-1/events",
    );
    FakeEventSource.current.emit("delta", { text: "我是 AI，通常会先暂停再沟通。" });
    FakeEventSource.current.emit("done", {});
    await flushPromises();
    expect(wrapper.text()).toContain("我是 AI，通常会先暂停再沟通。");
    expect(wrapper.text()).toContain("今日还可发送 49 条");

    candidateMessageFailure = "CANDIDATE_TWIN_QUOTA_USED";
    await wrapper.get(".candidate-twin-composer textarea").setValue("额度测试");
    await wrapper.get("form.candidate-twin-composer").trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain("今日候选分身消息额度已用完，明天再继续。");

    candidateMessageFailure = "CANDIDATE_TWIN_IN_PROGRESS";
    await wrapper.get(".candidate-twin-composer textarea").setValue("生成中测试");
    await wrapper.get("form.candidate-twin-composer").trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain("上一条候选分身回答仍在生成中。");

    candidateMessageFailure = "CANDIDATE_TWIN_UNAVAILABLE";
    await wrapper.get(".candidate-twin-composer textarea").setValue("不可用测试");
    await wrapper.get("form.candidate-twin-composer").trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain("这位候选目前无法继续分身会话。");

    candidateMessageFailure = "UNKNOWN_FAILURE";
    await wrapper.get(".candidate-twin-composer textarea").setValue("未知失败测试");
    await wrapper.get("form.candidate-twin-composer").trigger("submit");
    await flushPromises();
    const failedRequest = request.mock.calls.at(-1)![1]!;
    const failedMessageId = JSON.parse(
      failedRequest.body as string,
    ).clientMessageId;
    candidateMessageFailure = undefined;
    await wrapper.get("form.candidate-twin-composer").trigger("submit");
    await flushPromises();
    const retriedRequest = request.mock.calls.at(-1)![1]!;
    expect(JSON.parse(retriedRequest.body as string).clientMessageId).toBe(
      failedMessageId,
    );
    FakeEventSource.current.emit("done", {});

    await wrapper.get("button.close-candidate-twin").trigger("click");
    await wrapper
      .findAll("nav button")
      .find((button) => button.text().includes("我的分身"))!
      .trigger("click");
    await flushPromises();
    await wrapper.get("button.load-owned-candidate-conversations").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("会话 Z9Y8X7W6V5U4");
    expect(wrapper.text()).toContain("匿名访客原文");
    expect(wrapper.get(".owned-candidate-conversations").text()).not.toContain(
      "member@example.com",
    );
    expect(wrapper.find(".owned-candidate-conversations textarea").exists()).toBe(false);
  });

  it("sends and handles contact requests from the member UI", async () => {
    class FakeEventSource {
      static current: FakeEventSource;
      static instances: FakeEventSource[] = [];
      readonly listeners = new Map<string, (event: MessageEvent) => void>();

      constructor(readonly url: string) {
        FakeEventSource.current = this;
        FakeEventSource.instances.push(this);
      }

      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(type, listener);
      }

      close() {}

      emit(type: string, data: object) {
        this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const candidate = {
      id: "4ac4601b-4694-4da7-bd75-07f4330c94d5",
      avatarText: "北",
      nickname: "北川",
      age: 36,
      heightCm: 178,
      city: "上海",
      occupation: "工程师",
      reason: "你们可以进一步了解。",
    };
    let connected = false;
    let delayHumanConversation = false;
    let resolveHumanConversation: (() => void) | undefined;
    const contactState = () => ({
      incoming: [
        {
          id: "8caf3335-06ba-489f-8c5f-6dde88de541b",
          status: connected ? "accepted" : "pending",
          createdAt: "2026-08-22T08:00:00.000Z",
          expiresAt: "2026-08-29T08:00:00.000Z",
          conversation: {
            id: "anonymous-conversation",
            anonymousCode: "A1B2C3D4E5F6",
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
        },
      ],
      outgoing: [],
      currentConnection: connected
        ? {
            id: "current-connection",
            createdAt: "2026-08-22T08:00:00.000Z",
            conversation: { id: "human-conversation", unreadCount: 1 },
            candidate: {
              avatarText: "林",
              nickname: "林夏",
              age: 34,
              heightCm: 165,
              city: "上海",
              occupation: "设计师",
            },
          }
        : null,
    });
    const request = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "member@example.com", role: "member" },
          }),
        };
      }
      if (url === "/api/member/profile") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ profile: {}, matchCriteria: null }),
        };
      }
      if (url === "/api/member/recommendations") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            eligibility: { eligible: true, reasons: [] },
            capacity: 5,
            remainingCapacity: 4,
            dailyFetchAvailable: false,
            candidates: [candidate],
            followupQuestions: [],
          }),
        };
      }
      if (
        url === `/api/member/recommendations/${candidate.id}/twin-conversation`
      ) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            conversationId: "candidate-conversation",
            anonymousCode: "Z9Y8X7W6V5U4",
            profileVersion: { id: "portrait-version", version: 1 },
            candidate,
            canReply: true,
            messages: [
              { id: "message", role: "member", content: "我们聊过长期计划。" },
            ],
          }),
        };
      }
      if (
        url === `/api/member/recommendations/${candidate.id}/contact-request`
      ) {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: "outgoing-request",
            status: "pending",
            createdAt: "2026-08-22T08:00:00.000Z",
            expiresAt: "2026-08-29T08:00:00.000Z",
          }),
        };
      }
      if (url === "/api/member/contact-requests") {
        return { ok: true, status: 200, json: async () => contactState() };
      }
      if (
        url === "/api/member/human-conversations/human-conversation" &&
        !options?.method
      ) {
        if (delayHumanConversation) {
          await new Promise<void>((resolve) => {
            resolveHumanConversation = resolve;
          });
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            conversationId: "human-conversation",
            createdAt: "2026-08-22T08:00:00.000Z",
            canSend: true,
            otherMember: { displayName: "林夏", deleted: false },
            messages: [
              {
                id: "history-message",
                sender: "other",
                content: "很高兴正式认识你。",
                sequence: 1,
                createdAt: "2026-08-22T08:05:00.000Z",
              },
            ],
            unreadCount: 0,
            eventsUrl:
              "/api/member/human-conversations/human-conversation/events?after=1",
          }),
        };
      }
      if (
        url === "/api/member/human-conversations/human-conversation/messages" &&
        options?.method === "POST"
      ) {
        const body = JSON.parse(options.body as string) as {
          clientMessageId: string;
          content: string;
        };
        return {
          ok: true,
          status: 201,
          json: async () => ({
            message: {
              id: "sent-human-message",
              sender: "self",
              content: body.content,
              sequence: 2,
              createdAt: "2026-08-22T08:06:00.000Z",
            },
          }),
        };
      }
      if (
        url === "/api/member/human-conversations/human-conversation/read" &&
        options?.method === "POST"
      ) {
        return { ok: true, status: 204, json: async () => undefined };
      }
      if (
        url ===
        "/api/member/contact-requests/8caf3335-06ba-489f-8c5f-6dde88de541b/twin-conversation"
      ) {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            conversationId: "requester-twin-conversation",
            anonymousCode: "Q1W2E3R4T5Y6",
            profileVersion: { id: "requester-version", version: 1 },
            candidate: contactState().incoming[0]!.candidate,
            canReply: true,
            messages: [],
          }),
        };
      }
      if (
        url ===
          "/api/member/contact-requests/8caf3335-06ba-489f-8c5f-6dde88de541b/accept" &&
        options?.method === "POST"
      ) {
        connected = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            connection: {
              id: "current-connection",
              createdAt: "2026-08-22T08:00:00.000Z",
            },
          }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", request);
    const router = createRouter({ history: createMemoryHistory(), routes });
    const wrapper = mount(App, { global: { plugins: [router] } });
    await router.push("/app");
    await router.isReady();
    await flushPromises();

    await wrapper
      .findAll("nav button")
      .find((button) => button.text().includes("候选推荐"))!
      .trigger("click");
    await flushPromises();
    await wrapper.get("button.chat-candidate").trigger("click");
    await wrapper.get("#candidate-twin-consent").setValue(true);
    await wrapper.get("button.open-candidate-twin").trigger("click");
    await flushPromises();
    await wrapper.get("button.create-contact-request").trigger("click");
    await flushPromises();
    expect(request).toHaveBeenCalledWith(
      `/api/member/recommendations/${candidate.id}/contact-request`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(wrapper.text()).toContain("联系请求已发送");
    expect(wrapper.find(".candidate-twin-composer").exists()).toBe(false);

    await wrapper.get("button.close-candidate-twin").trigger("click");
    await wrapper
      .findAll("nav button")
      .find((button) => button.text().includes("联系"))!
      .trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("会话 A1B2C3D4E5F6");
    expect(wrapper.text()).toContain("林夏");
    expect(wrapper.get(".contact-request-card").text()).not.toMatch(
      /email|分数|隐藏标签/,
    );

    await wrapper.get("button.contact-request-twin").trigger("click");
    await wrapper.get("#candidate-twin-consent").setValue(true);
    await wrapper.get("button.open-candidate-twin").trigger("click");
    await flushPromises();
    expect(request).toHaveBeenCalledWith(
      "/api/member/contact-requests/8caf3335-06ba-489f-8c5f-6dde88de541b/twin-conversation",
      expect.objectContaining({ method: "POST" }),
    );
    await wrapper.get("button.close-candidate-twin").trigger("click");
    await wrapper.get("button.accept-contact-request").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("当前联系");
    expect(wrapper.text()).toContain("已与林夏建立联系");
    expect(wrapper.text()).toContain("1 条未读");

    await wrapper.get("button.open-human-conversation").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("很高兴正式认识你。");
    expect(FakeEventSource.current.url).toContain(
      "/api/member/human-conversations/human-conversation/events",
    );

    await wrapper
      .get("form.human-conversation-composer textarea")
      .setValue("微信 onlylove_2026，电话 13800138000。");
    await wrapper.get("form.human-conversation-composer").trigger("submit");
    await flushPromises();
    expect(wrapper.text()).toContain("微信 onlylove_2026，电话 13800138000。");
    FakeEventSource.current.emit("message", {
      id: "live-human-message",
      sender: "other",
      content: "收到，我们晚点聊。",
      sequence: 3,
      createdAt: "2026-08-22T08:07:00.000Z",
    });
    await flushPromises();
    expect(wrapper.text()).toContain("收到，我们晚点聊。");
    expect(request).toHaveBeenCalledWith(
      "/api/member/human-conversations/human-conversation/read",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ lastReadSequence: 3 }),
      }),
    );

    await wrapper.get(".human-conversation-heading button").trigger("click");
    delayHumanConversation = true;
    await wrapper.get("button.open-human-conversation").trigger("click");
    await flushPromises();
    expect(resolveHumanConversation).toBeTypeOf("function");
    await wrapper
      .findAll("nav button")
      .find((button) => button.text().includes("我的"))!
      .trigger("click");
    resolveHumanConversation!();
    await flushPromises();
    await wrapper
      .findAll("nav button")
      .find((button) => button.text().includes("联系"))!
      .trigger("click");
    await flushPromises();
    expect(wrapper.find(".human-conversation").exists()).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("completes the seven-day decision, private review, and resume flow", async () => {
    class FakeEventSource {
      readonly listeners = new Map<string, (event: MessageEvent) => void>();

      constructor(readonly url: string) {}

      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(type, listener);
      }

      close() {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const connectionId = "a7619c61-2cbd-4f72-8d1a-3d14f6479057";
    let currentConnection: Record<string, unknown> | null = {
      id: connectionId,
      createdAt: "2026-08-15T08:00:00.000Z",
      relationshipStatus: "active",
      followup: {
        due: true,
        myDecision: null,
        mutualContinue: false,
        confirmation: "none",
      },
      conversation: { id: "human-conversation", unreadCount: 0 },
      candidate: {
        avatarText: "林",
        nickname: "林夏",
        age: 34,
        heightCm: 165,
        city: "上海",
        occupation: "设计师",
      },
    };
    let recovery: Record<string, unknown> | null = null;
    const contactState = () => ({
      incoming: [],
      outgoing: [],
      currentConnection,
      recovery,
    });
    const request = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "member@example.com", role: "member" },
          }),
        };
      }
      if (url === "/api/member/profile") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ profile: {}, matchCriteria: null }),
        };
      }
      if (url === "/api/member/contact-requests") {
        return { ok: true, status: 200, json: async () => contactState() };
      }
      if (
        url === `/api/member/connections/${connectionId}/followup` &&
        options?.method === "POST"
      ) {
        const decision = JSON.parse(String(options.body)).decision;
        if (decision === "continue") {
          (currentConnection!.followup as Record<string, unknown>).myDecision =
            "continue";
        } else if (decision === "confirm") {
          currentConnection!.relationshipStatus = "confirmed";
          (currentConnection!.followup as Record<string, unknown>).confirmation =
            "confirmed";
        } else {
          currentConnection = null;
          recovery = { connectionId, status: "review_required" };
        }
        return { ok: true, status: 200, json: async () => contactState() };
      }
      if (url === "/api/member/interview") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            messages: [],
            fixedInterview: {
              answered: 10,
              total: 10,
              completed: true,
              question: null,
            },
            progress: { completed: 8, total: 8 },
          }),
        };
      }
      if (url === "/api/member/portrait") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "published",
            submittedVersion: { id: "review-version", version: 2 },
            publishedVersion: { id: "review-version", version: 2 },
          }),
        };
      }
      if (url === "/api/member/twin" && !options?.method) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            conversationId: null,
            profileVersion: { id: "review-version", version: 2 },
            messages: [],
          }),
        };
      }
      if (
        url === "/api/member/interview/messages" &&
        options?.method === "POST"
      ) {
        return {
          ok: true,
          status: 202,
          json: async () => ({
            eventsUrl: "/api/member/interview/jobs/review-job/events",
            quotaRemaining: 99,
          }),
        };
      }
      if (
        url === `/api/member/connections/${connectionId}/resume` &&
        options?.method === "POST"
      ) {
        recovery = { connectionId, status: "resumed" };
        return { ok: true, status: 200, json: async () => contactState() };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", request);
    const router = createRouter({ history: createMemoryHistory(), routes });
    const wrapper = mount(App, { global: { plugins: [router] } });
    await router.push("/app");
    await router.isReady();
    await flushPromises();
    await wrapper
      .findAll("nav button")
      .find((button) => button.text().includes("联系"))!
      .trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("七日回访");
    await wrapper.get("button.continue-connection").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("已选择继续了解");
    await wrapper.get("button.confirm-relationship").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("双方已确认关系");
    await wrapper.get("button.end-connection").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("私有接触复盘");

    await wrapper.get("button.start-connection-review").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("私有画像访谈员");
    expect(wrapper.get<HTMLTextAreaElement>("#interview-message").element.value).toContain(
      "复盘这段接触",
    );
    await wrapper.get("form.interview-composer").trigger("submit");
    await flushPromises();
    expect(request).toHaveBeenCalledWith(
      "/api/member/interview/messages",
      expect.objectContaining({ method: "POST" }),
    );

    recovery = { connectionId, status: "portrait_update_required" };
    await wrapper.get('button[data-twin-role="twin"]').trigger("click");
    await flushPromises();
    await wrapper
      .findAll("nav button")
      .find((button) => button.text().includes("联系"))!
      .trigger("click");
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("继续完善和校准"))!
      .trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("私有画像访谈员");

    recovery = { connectionId, status: "ready_to_resume" };
    await wrapper
      .findAll("nav button")
      .find((button) => button.text().includes("联系"))!
      .trigger("click");
    await flushPromises();
    await wrapper.get("button.resume-matching").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("已主动恢复推荐");
  });

  it("lets a super administrator update matching and agent quota settings", async () => {
    const request = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "admin@example.com", role: "super_admin" },
          }),
        };
      }
      if (url === "/api/admin/invitations") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ invitations: [] }),
        };
      }
      if (url === "/api/admin/matching-settings" && options?.method === "PUT") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidateCapacity: 3,
            minimumReciprocalScore: 72,
          }),
        };
      }
      if (url === "/api/admin/matching-settings") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidateCapacity: 5,
            minimumReciprocalScore: 60,
          }),
        };
      }
      if (
        url === "/api/admin/agent-quota-settings" &&
        options?.method === "PUT"
      ) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ownAgentDailyLimit: 120,
            candidateTwinDailyLimit: 60,
          }),
        };
      }
      if (url === "/api/admin/agent-quota-settings") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ownAgentDailyLimit: 100,
            candidateTwinDailyLimit: 50,
          }),
        };
      }
      if (url === "/api/admin/relationship-metrics") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            dueConnections: 10,
            mutualContinue: 6,
            noFeedback: 2,
            ended: 2,
            confirmed: 3,
            recoveryPending: 1,
            resumed: 4,
            mutualContinueRate: 60,
          }),
        };
      }
      if (url === "/api/admin/deleted-members") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ members: [] }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", request);
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push("/admin");
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper.get("#candidate-capacity").setValue(3);
    await wrapper.get("#minimum-reciprocal-score").setValue(72);
    await wrapper.get("form.matching-settings-form").trigger("submit");
    await flushPromises();
    expect(request).toHaveBeenCalledWith(
      "/api/admin/matching-settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          candidateCapacity: 3,
          minimumReciprocalScore: 72,
        }),
      }),
    );
    expect(wrapper.text()).toContain("推荐配置已保存");

    await wrapper.get("#own-agent-daily-limit").setValue(120);
    await wrapper.get("#candidate-twin-daily-limit").setValue(60);
    await wrapper.get("form.agent-quota-settings-form").trigger("submit");
    await flushPromises();
    expect(request).toHaveBeenCalledWith(
      "/api/admin/agent-quota-settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          ownAgentDailyLimit: 120,
          candidateTwinDailyLimit: 60,
        }),
      }),
    );
    expect(wrapper.text()).toContain("Agent 额度已保存");
    expect(wrapper.text()).toContain("七日双向继续率");
    expect(wrapper.text()).toContain("60%");
    expect(wrapper.text()).toContain("未反馈 2");
    expect(wrapper.text()).toContain("确认关系 3");
    expect(wrapper.text()).toContain("已恢复推荐 4");
  });

  it("shows governance guidance, correction feedback, and a separate appeal flow", async () => {
    let appealed = false;
    const request = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "member@example.com", role: "member" },
            requiresPasswordSetup: false,
          }),
        };
      }
      if (url === "/api/member/profile") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            profile: {
              nickname: "林夏",
              birthDate: "1992-04-12",
              gender: "female",
              heightCm: 165,
              city: "上海",
              occupation: "设计师",
            },
            matchCriteria: null,
          }),
        };
      }
      if (url === "/api/member/moderation") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            accessRestricted: false,
            suspendedUntil: null,
            receivedFeedback: [
              {
                id: "feedback-1",
                details: "计划描述不准确",
                createdAt: "2026-08-22T08:00:00.000Z",
                message: {
                  id: "message-1",
                  content: "我永远不会离开上海。",
                  createdAt: "2026-08-22T08:00:00.000Z",
                },
                correctionPrompt: "请通过理解纠正补充真实语境。",
              },
            ],
            submittedReports: [
              {
                id: "report-1",
                status: "resolved",
                outcome: "processed",
                createdAt: "2026-08-22T08:00:00.000Z",
              },
            ],
            receivedDecisions: [
              {
                caseId: "case-1",
                caseType: "report",
                originalCaseId: null,
                action: "warning",
                reason: "消息越过了对方边界。",
                suspendedUntil: null,
                createdAt: "2026-08-22T08:00:00.000Z",
                canAppeal: !appealed,
              },
              {
                caseId: "appeal-resolved",
                caseType: "appeal",
                originalCaseId: "case-old",
                action: "dismissed",
                reason: "复核理由成立。",
                suspendedUntil: null,
                createdAt: "2026-08-22T07:00:00.000Z",
                canAppeal: false,
              },
            ],
          }),
        };
      }
      if (
        url === "/api/member/moderation-cases/case-1/appeal" &&
        options?.method === "POST"
      ) {
        appealed = true;
        return {
          ok: true,
          status: 201,
          json: async () => ({ case: { id: "appeal-1", type: "appeal" } }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", request);
    vi.stubGlobal(
      "prompt",
      vi
        .fn()
        .mockReturnValueOnce("请求复核上下文")
        .mockReturnValueOnce("补充证据"),
    );
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push("/app");
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });
    await flushPromises();

    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("查看治理记录"))!
      .trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("普通理解误差用质量反馈");
    expect(wrapper.text()).toContain("我永远不会离开上海");
    expect(wrapper.text()).toContain("计划描述不准确");
    expect(wrapper.text()).toContain("撤销原处置");
    expect(wrapper.text()).toContain("为保护对方隐私，这里不披露具体处置");

    await wrapper.get(".moderation-list button.quiet-action").trigger("click");
    await flushPromises();
    expect(request).toHaveBeenCalledWith(
      "/api/member/moderation-cases/case-1/appeal",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          reason: "请求复核上下文",
          evidence: "补充证据",
        }),
      }),
    );
  });

  it("keeps a permanently banned member inside the review-only workspace", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/session") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              member: {
                email: "restricted@example.com",
                role: "member",
                suspendedUntil: "9999-12-31T23:59:59.999Z",
              },
              requiresPasswordSetup: false,
            }),
          };
        }
        if (url === "/api/member/moderation") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              accessRestricted: true,
              permanentlyBanned: true,
              suspendedUntil: "9999-12-31T23:59:59.999Z",
              receivedFeedback: [
                {
                  id: "feedback-1",
                  details: "计划描述不准确",
                  createdAt: "2026-08-22T08:00:00.000Z",
                  message: {
                    id: "message-1",
                    content: "我永远不会离开上海。",
                    createdAt: "2026-08-22T08:00:00.000Z",
                  },
                  correctionPrompt: "请通过理解纠正补充真实语境。",
                },
              ],
              submittedReports: [],
              receivedDecisions: [],
            }),
          };
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push("/app");
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.get(".moderation-restriction h2").text()).toContain("永久封禁");
    expect(wrapper.find("nav").exists()).toBe(false);
    expect(
      wrapper
        .findAll("button")
        .some((button) => button.text().includes("去补充真实语境")),
    ).toBe(false);
  });

  it("shows a recoverable error when a governance action loses the network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        if (url === "/api/session") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              member: { email: "member@example.com", role: "member" },
              requiresPasswordSetup: false,
            }),
          };
        }
        if (url === "/api/member/profile") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              profile: {
                nickname: "林夏",
                birthDate: "1992-04-12",
                gender: "female",
                heightCm: 165,
                city: "上海",
                occupation: "设计师",
              },
              matchCriteria: null,
            }),
          };
        }
        if (url === "/api/member/moderation") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              accessRestricted: false,
              permanentlyBanned: false,
              suspendedUntil: null,
              receivedFeedback: [],
              submittedReports: [],
              receivedDecisions: [
                {
                  caseId: "case-1",
                  caseType: "report",
                  originalCaseId: null,
                  action: "warning",
                  reason: "需要复核。",
                  suspendedUntil: null,
                  createdAt: "2026-08-22T08:00:00.000Z",
                  canAppeal: true,
                },
              ],
            }),
          };
        }
        if (
          url === "/api/member/moderation-cases/case-1/appeal" &&
          options?.method === "POST"
        ) {
          throw new TypeError("network unavailable");
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    vi.stubGlobal(
      "prompt",
      vi.fn().mockReturnValueOnce("申请复核").mockReturnValueOnce("补充证据"),
    );
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push("/app");
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("查看治理记录"))!
      .trigger("click");
    await flushPromises();
    await wrapper.get(".moderation-list button.quiet-action").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("复核申请没有提交，请稍后重试");
  });

  it("lets an ordinary administrator inspect and decide only a case-linked chat", async () => {
    let decided = false;
    let detailFails = false;
    const request = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "moderator@example.com", role: "admin" },
          }),
        };
      }
      if (url === "/api/admin/invitations") {
        return { ok: true, status: 200, json: async () => ({ invitations: [] }) };
      }
      if (url === "/api/admin/moderation-metrics") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ distortionFeedbackCount: 3, openCaseCount: 1 }),
        };
      }
      if (url === "/api/admin/moderation-cases") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            cases: [
              {
                id: "case-1",
                type: "report",
                targetKind: "human_message",
                reason: "伤害性消息",
                evidence: "关联消息",
                status: decided ? "resolved" : "pending",
                createdAt: "2026-08-22T08:00:00.000Z",
              },
            ],
          }),
        };
      }
      if (url === "/api/admin/moderation-cases/case-1" && !options?.method) {
        if (detailFails) throw new TypeError("network unavailable");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            case: {
              id: "case-1",
              type: "report",
              targetKind: "human_message",
              reason: "伤害性消息",
              evidence: "关联消息",
              status: decided ? "resolved" : "pending",
              createdAt: "2026-08-22T08:00:00.000Z",
            },
            decision: decided
              ? { action: "warning", reason: "越过边界", suspendedUntil: null }
              : null,
            chat: {
              conversationId: "conversation-1",
              messages: [
                { id: "message-1", content: "这是一条关联消息。", sequence: 1 },
              ],
            },
          }),
        };
      }
      if (
        url === "/api/admin/moderation-cases/case-1/decision" &&
        options?.method === "POST"
      ) {
        decided = true;
        return { ok: true, status: 200, json: async () => ({}) };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", request);
    vi.stubGlobal("prompt", vi.fn().mockReturnValue("越过边界"));
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push("/admin");
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.text()).toContain("举报与复核案件");
    expect(wrapper.text()).toContain("累计分身失真反馈 3 条");
    expect(request).not.toHaveBeenCalledWith("/api/admin/matching-settings");
    expect(request).toHaveBeenCalledWith("/api/admin/invitations");
    await wrapper.get(".moderation-case-list button").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("这是一条关联消息");
    const warning = wrapper
      .findAll(".moderation-decision-actions button")
      .find((button) => button.text() === "警告")!;
    await warning.trigger("click");
    await flushPromises();
    expect(request).toHaveBeenCalledWith(
      "/api/admin/moderation-cases/case-1/decision",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "warning", reason: "越过边界" }),
      }),
    );
    detailFails = true;
    await wrapper.get(".moderation-case-list button").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("无法读取案件关联证据");
    expect(wrapper.text()).not.toContain("这是一条关联消息");
  });
});
