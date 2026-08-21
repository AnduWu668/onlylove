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
    const passwordAction = wrapper
      .findAll("a")
      .find((link) => link.text().includes("设置或重置密码"))!;
    expect(passwordAction.exists()).toBe(true);
    await passwordAction.trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/login");
    expect(wrapper.get('button[type="submit"]').text()).toContain("获取验证码");
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

    expect(wrapper.text()).toContain("邀请管理");
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

  it("lets a super administrator update matching capacity and threshold", async () => {
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
  });
});
