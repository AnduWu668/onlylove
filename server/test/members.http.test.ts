import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { createApp } from "../src/app.js";
import { loadRootEnv } from "../src/env.js";
import { MemoryMailer } from "../src/modules/members/mailer.js";
import { Matching } from "../src/modules/matching/service.js";

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
  let adminCookie: string | undefined;

  async function setPassword(cookie: string, password = "secure-pass-123") {
    return app.inject({
      method: "PUT",
      url: "/api/auth/password",
      headers: { cookie },
      payload: { password },
    });
  }

  async function signInAdmin() {
    if (adminCookie) return adminCookie;
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
    adminCookie = signIn.cookies[0]?.name + "=" + signIn.cookies[0]?.value;
    expect((await setPassword(adminCookie)).statusCode).toBe(200);
    return adminCookie;
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

  async function signInMember(email: string) {
    await invite(email);
    const challenge = await app.inject({
      method: "POST",
      url: "/api/auth/otp",
      payload: { email },
    });
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: {
        email,
        challengeId: challenge.json().challengeId,
        code: mailer.lastCodeFor(email),
        birthDate: "1990-01-01",
      },
    });
    const cookie = signIn.cookies[0]?.name + "=" + signIn.cookies[0]?.value;
    expect((await setPassword(cookie)).statusCode).toBe(200);
    return cookie;
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
    adminCookie = undefined;
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
    expect(signIn.json().requiresPasswordSetup).toBe(true);
    const cookie = signIn.cookies[0]?.name + "=" + signIn.cookies[0]?.value;

    const blockedBeforePassword = await app.inject({
      method: "POST",
      url: "/api/admin/invitations",
      headers: { cookie },
      payload: { email: "member@onlylove.test" },
    });
    expect(blockedBeforePassword.statusCode).toBe(403);
    expect((await setPassword(cookie)).statusCode).toBe(200);

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
    expect(register.json().requiresPasswordSetup).toBe(true);

    const cookie = register.cookies[0]?.name + "=" + register.cookies[0]?.value;
    const session = await app.inject({
      method: "GET",
      url: "/api/session",
      headers: { cookie },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().member.email).toBe("adult@onlylove.test");
    expect(session.json().requiresPasswordSetup).toBe(true);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/member/profile",
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(401);

    expect(
      (
        await setPassword(cookie, "short")
      ).json().code,
    ).toBe("INVALID_PASSWORD");
    expect((await setPassword(cookie, "x".repeat(21))).statusCode).toBe(400);
    expect((await setPassword(cookie, "123456")).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/session",
          headers: { cookie },
        })
      ).json().requiresPasswordSetup,
    ).toBe(false);

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

  it("signs in with a password and resets a forgotten password through OTP", async () => {
    const email = "password@onlylove.test";
    const oldPassword = "secure-pass-123";
    const newPassword = "new-secure-pass-456";
    const oldCookie = await signInMember(email);
    const pool = new Pool({ connectionString: databaseUrl });
    const storedPassword = await pool.query(
      "select password_hash from members where email = $1",
      [email],
    );
    await pool.end();
    expect(storedPassword.rows[0].password_hash).toMatch(/^scrypt\$/);
    expect(storedPassword.rows[0].password_hash).not.toContain(oldPassword);

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: "definitely wrong" },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.json().code).toBe("INVALID_CREDENTIALS");

    const passwordLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: oldPassword },
    });
    expect(passwordLogin.statusCode).toBe(200);
    expect(passwordLogin.json()).toMatchObject({
      member: { email },
      requiresPasswordSetup: false,
    });

    currentTime = new Date(currentTime.getTime() + 60_000);
    const challenge = await app.inject({
      method: "POST",
      url: "/api/auth/otp",
      payload: { email },
    });
    const reset = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: {
        email,
        challengeId: challenge.json().challengeId,
        code: mailer.lastCodeFor(email),
      },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().requiresPasswordSetup).toBe(true);
    const resetCookie = reset.cookies[0]?.name + "=" + reset.cookies[0]?.value;
    expect((await setPassword(resetCookie, newPassword)).statusCode).toBe(200);

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/session",
          headers: { cookie: oldCookie },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { email, password: oldPassword },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { email, password: newPassword },
        })
      ).statusCode,
    ).toBe(200);
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

  it("lets a member save, read, and version only their own profile and match criteria", async () => {
    const cookie = await signInMember("profile@onlylove.test");
    currentTime = new Date(currentTime.getTime() + 60_000);
    const otherCookie = await signInMember("other-profile@onlylove.test");
    const firstProfile = {
      nickname: "林夏",
      birthDate: "1990-04-12",
      gender: "female",
      heightCm: 165,
      city: "上海",
      occupation: "产品设计师",
    };
    const criteria = {
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
    };

    const firstSave = await app.inject({
      method: "PUT",
      url: "/api/member/profile",
      headers: { cookie },
      payload: { profile: firstProfile, matchCriteria: criteria },
    });
    expect(firstSave.statusCode).toBe(200);
    expect(firstSave.json()).toMatchObject({
      profile: firstProfile,
      matchCriteria: { ...criteria, version: 1 },
    });

    const ownProfile = await app.inject({
      method: "GET",
      url: "/api/member/profile",
      headers: { cookie },
    });
    expect(ownProfile.statusCode).toBe(200);
    expect(ownProfile.json()).toEqual(firstSave.json());

    const otherProfile = await app.inject({
      method: "GET",
      url: "/api/member/profile",
      headers: { cookie: otherCookie },
    });
    expect(otherProfile.statusCode).toBe(200);
    expect(otherProfile.json().profile.nickname).toBe("");
    expect(otherProfile.json().matchCriteria).toBeNull();

    const secondSave = await app.inject({
      method: "PUT",
      url: "/api/member/profile",
      headers: { cookie },
      payload: {
        profile: { ...firstProfile, nickname: "林夏夏" },
        matchCriteria: {
          ...criteria,
          ageMinimum: null,
          ageMaximum: null,
          ageMode: null,
        },
      },
    });
    expect(secondSave.statusCode).toBe(200);
    expect(secondSave.json()).toMatchObject({
      profile: { nickname: "林夏夏" },
      matchCriteria: { version: 2, ageMinimum: null, ageMode: null },
    });
  });

  it("returns the saved profile when recommendation recheck fails after commit", async () => {
    const cookie = await signInMember("saved-profile@onlylove.test");
    const recheck = vi
      .spyOn(Matching.prototype, "recheckForMember")
      .mockRejectedValueOnce(new Error("test recheck failure"));
    const profile = {
      nickname: "已保存成员",
      birthDate: "1990-01-01",
      gender: "female",
      heightCm: 165,
      city: "上海",
      occupation: "设计师",
    } as const;
    const matchCriteria = {
      desiredGender: "male",
      ageMinimum: 28,
      ageMaximum: 38,
      ageMode: "required",
      heightMinimumCm: null,
      heightMaximumCm: null,
      heightMode: null,
      acceptableCities: ["上海"],
      occupationRequirement: null,
      occupationMode: null,
    } as const;

    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/member/profile",
        headers: { cookie },
        payload: { profile, matchCriteria },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        profile,
        matchCriteria: { ...matchCriteria, version: 1 },
      });

      const pool = new Pool({ connectionString: databaseUrl });
      const stored = await pool.query<{ nickname: string; versions: string }>(
        `SELECT m.nickname, COUNT(c.id)::text AS versions
           FROM members m
           LEFT JOIN match_criteria_versions c ON c.member_id = m.id
          WHERE m.email = $1
          GROUP BY m.nickname`,
        ["saved-profile@onlylove.test"],
      );
      await pool.end();
      expect(stored.rows[0]).toEqual({ nickname: "已保存成员", versions: "1" });
    } finally {
      recheck.mockRestore();
    }
  });

  it("validates the adult heterosexual profile boundary on the server", async () => {
    const cookie = await signInMember("boundary@onlylove.test");
    const profile = {
      nickname: "边界成员",
      birthDate: "2008-08-21",
      gender: "female",
      heightCm: 165,
      city: "上海",
      occupation: "教师",
    };
    const matchCriteria = {
      desiredGender: "female",
      ageMinimum: null,
      ageMaximum: null,
      ageMode: null,
      heightMinimumCm: null,
      heightMaximumCm: null,
      heightMode: null,
      acceptableCities: ["上海"],
      occupationRequirement: null,
      occupationMode: null,
    };

    const minor = await app.inject({
      method: "PUT",
      url: "/api/member/profile",
      headers: { cookie },
      payload: { profile, matchCriteria },
    });
    expect(minor.statusCode).toBe(400);
    expect(minor.json()).toMatchObject({
      code: "INVALID_PROFILE",
      field: "birthDate",
    });

    const sameGender = await app.inject({
      method: "PUT",
      url: "/api/member/profile",
      headers: { cookie },
      payload: {
        profile: { ...profile, birthDate: "1990-01-01" },
        matchCriteria,
      },
    });
    expect(sameGender.statusCode).toBe(400);
    expect(sameGender.json()).toMatchObject({
      code: "INVALID_MATCH_CRITERIA",
      field: "desiredGender",
    });

    const uncommonButValidValues = await app.inject({
      method: "PUT",
      url: "/api/member/profile",
      headers: { cookie },
      payload: {
        profile: {
          ...profile,
          birthDate: "1900-01-01",
          heightCm: 221,
        },
        matchCriteria: {
          ...matchCriteria,
          desiredGender: "male",
          ageMinimum: 100,
          ageMaximum: 110,
          ageMode: "preferred",
          heightMinimumCm: 100,
          heightMaximumCm: 250,
          heightMode: "required",
          acceptableCities: Array.from(
            { length: 11 },
            (_, index) => `城市${index + 1}`,
          ),
        },
      },
    });
    expect(uncommonButValidValues.statusCode).toBe(200);

    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/member/profile",
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("logically deletes a member and lets only the super administrator restore or purge it", async () => {
    const email = "deleted@onlylove.test";
    const memberCookie = await signInMember(email);
    const superAdminCookie = await signInAdmin();

    const memberCannotManageDeletedAccounts = await app.inject({
      method: "GET",
      url: "/api/admin/deleted-members",
      headers: { cookie: memberCookie },
    });
    expect(memberCannotManageDeletedAccounts.statusCode).toBe(403);

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/member",
      headers: { cookie: memberCookie },
    });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.cookies[0]).toMatchObject({
      name: "onlylove_session",
      value: "",
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/session",
          headers: { cookie: memberCookie },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { email, password: "secure-pass-123" },
        })
      ).statusCode,
    ).toBe(401);

    const listed = await app.inject({
      method: "GET",
      url: "/api/admin/deleted-members",
      headers: { cookie: superAdminCookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().members).toEqual([
      expect.objectContaining({ email, nickname: null }),
    ]);
    const memberId = listed.json().members[0].id;

    await invite(email);
    const retainedEmail = await app.inject({
      method: "POST",
      url: "/api/auth/otp",
      payload: { email },
    });
    expect(retainedEmail.statusCode).toBe(403);
    expect(retainedEmail.json().code).toBe("ACCOUNT_DELETED");

    currentTime = new Date(currentTime.getTime() + 1);
    const restored = await app.inject({
      method: "POST",
      url: `/api/admin/deleted-members/${memberId}/restore`,
      headers: { cookie: superAdminCookie },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ id: memberId, email });

    const signedInAgain = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: "secure-pass-123" },
    });
    expect(signedInAgain.statusCode).toBe(200);
    const restoredCookie =
      signedInAgain.cookies[0]?.name + "=" + signedInAgain.cookies[0]?.value;
    currentTime = new Date(currentTime.getTime() + 1);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/member",
          headers: { cookie: restoredCookie },
        })
      ).statusCode,
    ).toBe(204);

    currentTime = new Date(currentTime.getTime() + 1);
    const purged = await app.inject({
      method: "DELETE",
      url: `/api/admin/deleted-members/${memberId}`,
      headers: { cookie: superAdminCookie },
    });
    expect(purged.statusCode).toBe(204);
    const afterPurge = await app.inject({
      method: "GET",
      url: "/api/admin/deleted-members",
      headers: { cookie: superAdminCookie },
    });
    expect(afterPurge.json().members).toEqual([]);

    const audit = await app.inject({
      method: "GET",
      url: "/api/admin/member-deletion-audit",
      headers: { cookie: superAdminCookie },
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().audits.map(({ action }: { action: string }) => action)).toEqual([
      "purged",
      "deleted",
      "restored",
      "deleted",
    ]);

    await invite(email);
    const emailAvailableAgain = await app.inject({
      method: "POST",
      url: "/api/auth/otp",
      payload: { email },
    });
    expect(emailAvailableAgain.statusCode).toBe(202);
    expect(emailAvailableAgain.json().requiresBirthDate).toBe(true);
  });
});
