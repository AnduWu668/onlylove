import { mount } from "@vue/test-utils";
import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import App from "./App.vue";
import { routes } from "./router.js";

describe("OnlyLove UI seam", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the mobile email-code sign-in flow", async () => {
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push("/login");
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });

    expect(wrapper.text()).toContain("认真了解，再决定靠近");
    expect(wrapper.get('input[type="email"]').attributes("autocomplete")).toBe(
      "email",
    );
    expect(wrapper.get("button").text()).toContain("获取验证码");
  });

  it("moves an invited member from email to the six-digit code step", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({
          challengeId: "1dc8b163-2270-42b6-a90a-dbb3b887501e",
          requiresBirthDate: true,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          member: { email: "member@example.com", role: "member" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          member: { email: "member@example.com", role: "member" },
        }),
      });
    vi.stubGlobal("fetch", request);
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push("/login");
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });

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

    expect(request).toHaveBeenNthCalledWith(
      2,
      "/api/auth/verify",
      expect.objectContaining({
        body: expect.stringContaining('"birthDate":"1990-01-01"'),
      }),
    );
    expect(router.currentRoute.value.fullPath).toBe("/app");
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
    const request = vi.fn(async (url: string) => {
      if (url === "/api/session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            member: { email: "admin@example.com", role: "super_admin" },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          invitations: [
            {
              id: "1dc8b163-2270-42b6-a90a-dbb3b887501e",
              email: "invited@example.com",
              status: "active",
              expiresAt: "2026-08-27T08:00:00.000Z",
            },
          ],
        }),
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
  });
});
