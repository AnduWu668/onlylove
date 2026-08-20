import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
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

describe("Members HTTP seam", () => {
  let app: FastifyInstance;
  let mailer: MemoryMailer;
  let currentTime: Date;

  async function signInAdmin() {
    const challenge = await app.inject({
      method: "POST",
      url: "/api/auth/otp",
      payload: { email: "admin@onlylove.test" },
    });
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: {
        email: "admin@onlylove.test",
        challengeId: challenge.json().challengeId,
        code: mailer.lastCodeFor("admin@onlylove.test"),
      },
    });
    return signIn.cookies[0]?.name + "=" + signIn.cookies[0]?.value;
  }

  async function invite(email: string) {
    const cookie = await signInAdmin();
    return app.inject({
      method: "POST",
      url: "/api/admin/invitations",
      headers: { cookie },
      payload: { email },
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
    await pool.query(
      "TRUNCATE sessions, otp_challenges, invitations, members CASCADE",
    );
    await pool.end();

    currentTime = new Date("2026-08-20T08:00:00.000Z");
    mailer = new MemoryMailer();
    app = await createApp({
      databaseUrl,
      mailer,
      otpSecret: "test-only-secret",
      superAdminEmail: "admin@onlylove.test",
      now: () => currentTime,
    });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("lets the configured super administrator sign in and issue an invitation", async () => {
    const requestCode = await app.inject({
      method: "POST",
      url: "/api/auth/otp",
      payload: { email: "admin@onlylove.test" },
    });

    expect(requestCode.statusCode).toBe(202);
    const code = mailer.lastCodeFor("admin@onlylove.test");
    expect(code).toMatch(/^\d{6}$/);

    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: {
        email: "admin@onlylove.test",
        challengeId: requestCode.json().challengeId,
        code,
      },
    });

    expect(signIn.statusCode).toBe(200);
    expect(signIn.json().member).toMatchObject({ role: "super_admin" });
    const cookie = signIn.cookies[0]?.name + "=" + signIn.cookies[0]?.value;

    const invitation = await app.inject({
      method: "POST",
      url: "/api/admin/invitations",
      headers: { cookie },
      payload: { email: "member@onlylove.test" },
    });

    expect(invitation.statusCode).toBe(201);
    expect(invitation.json()).toMatchObject({
      email: "member@onlylove.test",
      status: "active",
    });
  });

  it("registers an invited adult once and exposes the member through the session", async () => {
    await invite("adult@onlylove.test");

    const requestCode = await app.inject({
      method: "POST",
      url: "/api/auth/otp",
      payload: { email: "adult@onlylove.test" },
    });
    expect(requestCode.statusCode).toBe(202);
    expect(requestCode.json().requiresBirthDate).toBe(true);

    const register = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: {
        email: "adult@onlylove.test",
        challengeId: requestCode.json().challengeId,
        code: mailer.lastCodeFor("adult@onlylove.test"),
        birthDate: "1990-01-01",
      },
    });
    expect(register.statusCode).toBe(200);
    expect(register.json().member).toMatchObject({
      email: "adult@onlylove.test",
      role: "member",
    });

    const cookie = register.cookies[0]?.name + "=" + register.cookies[0]?.value;
    const session = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().member.email).toBe("adult@onlylove.test");

    const memberCannotInvite = await app.inject({
      method: "POST",
      url: "/api/admin/invitations",
      headers: { cookie },
      payload: { email: "other@onlylove.test" },
    });
    expect(memberCannotInvite.statusCode).toBe(403);

    const signOut = await app.inject({
      method: "DELETE",
      url: "/api/session",
      headers: { cookie },
    });
    expect(signOut.statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/session",
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(401);

    const reuse = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: {
        email: "adult@onlylove.test",
        challengeId: requestCode.json().challengeId,
        code: mailer.lastCodeFor("adult@onlylove.test"),
        birthDate: "1990-01-01",
      },
    });
    expect(reuse.statusCode).toBe(400);
  });

  it("enforces the invitation role, revocation, reissue, and seven-day expiry", async () => {
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/admin/invitations",
      payload: { email: "member@onlylove.test" },
    });
    expect(forbidden.statusCode).toBe(403);

    const cookie = await signInAdmin();
    const issued = await app.inject({
      method: "POST",
      url: "/api/admin/invitations",
      headers: { cookie },
      payload: { email: "member@onlylove.test" },
    });

    const revoked = await app.inject({
      method: "POST",
      url: `/api/admin/invitations/${issued.json().id}/revoke`,
      headers: { cookie },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().status).toBe("revoked");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/otp",
          payload: { email: "member@onlylove.test" },
        })
      ).statusCode,
    ).toBe(403);

    const reissued = await app.inject({
      method: "POST",
      url: `/api/admin/invitations/${issued.json().id}/reissue`,
      headers: { cookie },
    });
    expect(reissued.statusCode).toBe(201);
    expect(reissued.json()).toMatchObject({
      email: "member@onlylove.test",
      status: "active",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/otp",
          payload: { email: "member@onlylove.test" },
        })
      ).statusCode,
    ).toBe(202);

    const expiring = await app.inject({
      method: "POST",
      url: "/api/admin/invitations",
      headers: { cookie },
      payload: { email: "expired@onlylove.test" },
    });
    expect(expiring.statusCode).toBe(201);
    currentTime = new Date(currentTime.getTime() + 7 * 24 * 60 * 60_000 + 1);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/otp",
          payload: { email: "expired@onlylove.test" },
        })
      ).statusCode,
    ).toBe(403);

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/invitations",
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().invitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          email: "member@onlylove.test",
          status: "revoked",
        }),
        expect.objectContaining({
          email: "expired@onlylove.test",
          status: "expired",
        }),
      ]),
    );
  });

  it("allows an OTP resend only after sixty seconds and invalidates the old code", async () => {
    await invite("resend@onlylove.test");
    const first = await app.inject({
      method: "POST",
      url: "/api/auth/otp",
      payload: { email: "resend@onlylove.test" },
    });
    const firstCode = mailer.lastCodeFor("resend@onlylove.test");

    const tooSoon = await app.inject({
      method: "POST",
      url: "/api/auth/otp",
      payload: { email: "resend@onlylove.test" },
    });
    expect(tooSoon.statusCode).toBe(429);

    currentTime = new Date(currentTime.getTime() + 60_000);
    const resent = await app.inject({
      method: "POST",
      url: "/api/auth/otp",
      payload: { email: "resend@onlylove.test" },
    });
    expect(resent.statusCode).toBe(202);

    const oldCode = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: {
        email: "resend@onlylove.test",
        challengeId: first.json().challengeId,
        code: firstCode,
        birthDate: "1990-01-01",
      },
    });
    expect(oldCode.statusCode).toBe(400);
  });

  it("allows another OTP request immediately when email delivery fails", async () => {
    await app.close();
    let deliveryAttempts = 0;
    app = await createApp({
      databaseUrl,
      mailer: {
        async sendOtp() {
          deliveryAttempts += 1;
          if (deliveryAttempts === 1) throw new Error("SMTP unavailable");
        },
      },
      otpSecret: "test-only-secret",
      superAdminEmail: "admin@onlylove.test",
      now: () => currentTime,
    });

    const failed = await app.inject({
      method: "POST",
      url: "/api/auth/otp",
      payload: { email: "admin@onlylove.test" },
    });
    expect(failed.statusCode).toBe(500);

    const retry = await app.inject({
      method: "POST",
      url: "/api/auth/otp",
      payload: { email: "admin@onlylove.test" },
    });
    expect(retry.statusCode).toBe(202);
  });

  it("expires an OTP after ten minutes", async () => {
    await invite("expiry@onlylove.test");
    const challenge = await app.inject({
      method: "POST",
      url: "/api/auth/otp",
      payload: { email: "expiry@onlylove.test" },
    });
    const code = mailer.lastCodeFor("expiry@onlylove.test");
    currentTime = new Date(currentTime.getTime() + 10 * 60_000);

    const expired = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: {
        email: "expiry@onlylove.test",
        challengeId: challenge.json().challengeId,
        code,
        birthDate: "1990-01-01",
      },
    });
    expect(expired.statusCode).toBe(400);
    expect(expired.json().code).toBe("OTP_EXPIRED");
  });

  it("invalidates an OTP after five wrong attempts", async () => {
    await invite("attempts@onlylove.test");
    const challenge = await app.inject({
      method: "POST",
      url: "/api/auth/otp",
      payload: { email: "attempts@onlylove.test" },
    });
    const code = mailer.lastCodeFor("attempts@onlylove.test")!;
    const wrongCode = code === "000000" ? "111111" : "000000";

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/verify",
        payload: {
          email: "attempts@onlylove.test",
          challengeId: challenge.json().challengeId,
          code: wrongCode,
          birthDate: "1990-01-01",
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe(
        attempt === 5 ? "OTP_ATTEMPTS_EXCEEDED" : "INVALID_OTP",
      );
    }

    const locked = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: {
        email: "attempts@onlylove.test",
        challengeId: challenge.json().challengeId,
        code,
        birthDate: "1990-01-01",
      },
    });
    expect(locked.statusCode).toBe(400);
    expect(locked.json().code).toBe("OTP_ATTEMPTS_EXCEEDED");
  });

  it("rejects registration before the member turns eighteen", async () => {
    await invite("minor@onlylove.test");
    const challenge = await app.inject({
      method: "POST",
      url: "/api/auth/otp",
      payload: { email: "minor@onlylove.test" },
    });
    const registration = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: {
        email: "minor@onlylove.test",
        challengeId: challenge.json().challengeId,
        code: mailer.lastCodeFor("minor@onlylove.test"),
        birthDate: "2008-08-21",
      },
    });
    expect(registration.statusCode).toBe(403);
    expect(registration.json().code).toBe("ADULTS_ONLY");
  });
});
