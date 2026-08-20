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
    FakeEventSource.current.emit("done", {});
    await flushPromises();
    expect(wrapper.text()).toContain("什么信号会让你愿意重新开始沟通？");
    expect(wrapper.text()).toContain("今日还可发送 99 条");
  });
});
