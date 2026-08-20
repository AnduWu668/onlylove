import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "../../db.js";
import type { Mailer } from "./mailer.js";
import { invitations, members, otpChallenges, sessions } from "./schema.js";

const emailSchema = {
  type: "object",
  additionalProperties: false,
  required: ["email"],
  properties: { email: { type: "string", format: "email", maxLength: 320 } },
} as const;

type Member = typeof members.$inferSelect;

export interface MembersOptions {
  db: Database;
  mailer: Mailer;
  now: () => Date;
  otpSecret: string;
  production: boolean;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function hashOtp(secret: string, challengeId: string, code: string) {
  return createHmac("sha256", secret)
    .update(`${challengeId}:${code}`)
    .digest("hex");
}

function sameHash(left: string, right: string) {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function publicMember(member: Member) {
  return { email: member.email, role: member.role };
}

function publicInvitation(
  invitation: typeof invitations.$inferSelect,
  now: Date,
) {
  const status = invitation.usedAt
    ? "used"
    : invitation.revokedAt
      ? "revoked"
      : invitation.expiresAt <= now
        ? "expired"
        : "active";
  return {
    id: invitation.id,
    email: invitation.email,
    status,
    expiresAt: invitation.expiresAt.toISOString(),
  };
}

async function issueInvitation(
  db: Database,
  email: string,
  issuedBy: string,
  now: Date,
) {
  return db.transaction(async (transaction) => {
    await transaction
      .update(invitations)
      .set({ revokedAt: now })
      .where(
        and(
          eq(invitations.email, email),
          isNull(invitations.usedAt),
          isNull(invitations.revokedAt),
        ),
      );
    return (
      await transaction
        .insert(invitations)
        .values({
          id: randomUUID(),
          email,
          issuedBy,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60_000),
        })
        .returning()
    )[0]!;
  });
}

function isAdult(birthDate: string, now: Date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return false;
  const parsed = new Date(`${birthDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== birthDate) {
    return false;
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );
  return birthDate <= `${Number(parts.year) - 18}-${parts.month}-${parts.day}`;
}

export async function bootstrapSuperAdmin(
  db: Database,
  email: string,
  now: Date,
) {
  await db
    .insert(members)
    .values({
      id: randomUUID(),
      email: normalizeEmail(email),
      role: "super_admin",
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: members.email,
      set: { role: "super_admin", deletedAt: null },
    });
}

async function memberForRequest(
  request: FastifyRequest,
  db: Database,
  now: Date,
) {
  const token = request.cookies.onlylove_session;
  if (!token) return undefined;

  const rows = await db
    .select({ member: members })
    .from(sessions)
    .innerJoin(members, eq(sessions.memberId, members.id))
    .where(
      and(
        eq(sessions.tokenHash, hash(token)),
        gt(sessions.expiresAt, now),
        isNull(members.deletedAt),
      ),
    )
    .limit(1);
  return rows[0]?.member;
}

export function registerMembersRoutes(
  app: FastifyInstance,
  { db, mailer, now, otpSecret, production }: MembersOptions,
) {
  app.post<{ Body: { email: string } }>(
    "/api/auth/otp",
    { schema: { body: emailSchema } },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      const member = await db
        .select()
        .from(members)
        .where(and(eq(members.email, email), isNull(members.deletedAt)))
        .limit(1);
      if (!member[0]) {
        const invitation = await db
          .select({ id: invitations.id })
          .from(invitations)
          .where(
            and(
              eq(invitations.email, email),
              isNull(invitations.revokedAt),
              isNull(invitations.usedAt),
              gt(invitations.expiresAt, now()),
            ),
          )
          .limit(1);
        if (!invitation[0]) {
          return reply.code(403).send({ code: "INVITATION_REQUIRED" });
        }
      }
      const requestedAt = now();
      const challenge = await db.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext(${email}))`,
        );
        const latest = (
          await transaction
            .select({ resendAt: otpChallenges.resendAt })
            .from(otpChallenges)
            .where(eq(otpChallenges.email, email))
            .orderBy(desc(otpChallenges.createdAt))
            .limit(1)
        )[0];
        if (latest && latest.resendAt > requestedAt) return undefined;

        await transaction
          .update(otpChallenges)
          .set({ consumedAt: requestedAt })
          .where(
            and(
              eq(otpChallenges.email, email),
              isNull(otpChallenges.consumedAt),
            ),
          );
        const id = randomUUID();
        const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
        await transaction.insert(otpChallenges).values({
          id,
          email,
          codeHash: hashOtp(otpSecret, id, code),
          createdAt: requestedAt,
          expiresAt: new Date(requestedAt.getTime() + 10 * 60_000),
          resendAt: new Date(requestedAt.getTime() + 60_000),
        });
        return { id, code };
      });
      if (!challenge) {
        return reply.code(429).send({ code: "OTP_RESEND_TOO_SOON" });
      }
      await mailer.sendOtp(email, challenge.code);
      return reply
        .code(202)
        .send({ challengeId: challenge.id, requiresBirthDate: !member[0] });
    },
  );

  app.post<{
    Body: {
      email: string;
      challengeId: string;
      code: string;
      birthDate?: string;
    };
  }>(
    "/api/auth/verify",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "challengeId", "code"],
          properties: {
            email: { type: "string", format: "email", maxLength: 320 },
            challengeId: { type: "string", format: "uuid" },
            code: { type: "string", pattern: "^[0-9]{6}$" },
            birthDate: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
          },
        },
      },
    },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      const sessionToken = randomUUID() + randomUUID();
      const signedInAt = now();
      const result = await db.transaction(async (transaction) => {
        const challenge = await transaction
          .select()
          .from(otpChallenges)
          .where(
            and(
              eq(otpChallenges.id, request.body.challengeId),
              eq(otpChallenges.email, email),
              isNull(otpChallenges.consumedAt),
            ),
          )
          .limit(1)
          .for("update");
        const current = challenge[0];
        if (!current) return { error: "INVALID_OTP" as const };
        if (current.expiresAt <= signedInAt) {
          return { error: "OTP_EXPIRED" as const };
        }
        if (current.attempts >= 5) {
          return { error: "OTP_ATTEMPTS_EXCEEDED" as const };
        }
        if (
          !sameHash(
            current.codeHash,
            hashOtp(otpSecret, current.id, request.body.code),
          )
        ) {
          const attempts = current.attempts + 1;
          await transaction
            .update(otpChallenges)
            .set({ attempts })
            .where(eq(otpChallenges.id, current.id));
          return {
            error:
              attempts >= 5
                ? ("OTP_ATTEMPTS_EXCEEDED" as const)
                : ("INVALID_OTP" as const),
          };
        }

        let signedInMember = (
          await transaction
            .select()
            .from(members)
            .where(and(eq(members.email, email), isNull(members.deletedAt)))
            .limit(1)
        )[0];

        if (!signedInMember) {
          if (!request.body.birthDate || !isAdult(request.body.birthDate, signedInAt)) {
            return { error: "ADULTS_ONLY" as const };
          }
          const invitation = (
            await transaction
              .select()
              .from(invitations)
              .where(
                and(
                  eq(invitations.email, email),
                  isNull(invitations.revokedAt),
                  isNull(invitations.usedAt),
                  gt(invitations.expiresAt, signedInAt),
                ),
              )
              .limit(1)
              .for("update")
          )[0];
          if (!invitation) return { error: "INVITATION_REQUIRED" as const };

          signedInMember = (
            await transaction
              .insert(members)
              .values({
                id: randomUUID(),
                email,
                role: "member",
                birthDate: request.body.birthDate,
                createdAt: signedInAt,
              })
              .returning()
          )[0]!;
          await transaction
            .update(invitations)
            .set({ usedAt: signedInAt })
            .where(eq(invitations.id, invitation.id));
        }

        await transaction
          .update(otpChallenges)
          .set({ consumedAt: signedInAt })
          .where(eq(otpChallenges.id, request.body.challengeId));
        await transaction.insert(sessions).values({
          id: randomUUID(),
          memberId: signedInMember.id,
          tokenHash: hash(sessionToken),
          createdAt: signedInAt,
          expiresAt: new Date(signedInAt.getTime() + 30 * 24 * 60 * 60_000),
        });
        return { member: signedInMember };
      });

      if ("error" in result) {
        const status =
          result.error === "INVALID_OTP" ||
          result.error === "OTP_EXPIRED" ||
          result.error === "OTP_ATTEMPTS_EXCEEDED"
            ? 400
            : 403;
        return reply.code(status).send({ code: result.error });
      }

      reply.setCookie("onlylove_session", sessionToken, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: production,
        maxAge: 30 * 24 * 60 * 60,
      });
      return { member: publicMember(result.member) };
    },
  );

  app.get("/api/session", async (request, reply) => {
    const member = await memberForRequest(request, db, now());
    if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
    return { member: publicMember(member) };
  });

  app.delete("/api/session", async (request, reply) => {
    const token = request.cookies.onlylove_session;
    if (token) {
      await db.delete(sessions).where(eq(sessions.tokenHash, hash(token)));
    }
    reply.clearCookie("onlylove_session", { path: "/" });
    return reply.code(204).send();
  });

  app.get("/api/admin/invitations", async (request, reply) => {
    const requestedAt = now();
    const actor = await memberForRequest(request, db, requestedAt);
    if (actor?.role !== "super_admin") {
      return reply.code(403).send({ code: "FORBIDDEN" });
    }
    const rows = await db
      .select()
      .from(invitations)
      .orderBy(desc(invitations.createdAt));
    return {
      invitations: rows.map((invitation) =>
        publicInvitation(invitation, requestedAt),
      ),
    };
  });

  app.post<{ Body: { email: string } }>(
    "/api/admin/invitations",
    { schema: { body: emailSchema } },
    async (request, reply) => {
      const actor = await memberForRequest(request, db, now());
      if (actor?.role !== "super_admin") {
        return reply.code(403).send({ code: "FORBIDDEN" });
      }

      const email = normalizeEmail(request.body.email);
      const createdAt = now();
      const invitation = await issueInvitation(db, email, actor.id, createdAt);
      return reply.code(201).send(publicInvitation(invitation, createdAt));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/admin/invitations/:id/revoke",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const changedAt = now();
      const actor = await memberForRequest(request, db, changedAt);
      if (actor?.role !== "super_admin") {
        return reply.code(403).send({ code: "FORBIDDEN" });
      }
      const invitation = (
        await db
          .update(invitations)
          .set({ revokedAt: changedAt })
          .where(
            and(
              eq(invitations.id, request.params.id),
              isNull(invitations.revokedAt),
              isNull(invitations.usedAt),
              gt(invitations.expiresAt, changedAt),
            ),
          )
          .returning()
      )[0];
      if (!invitation) return reply.code(409).send({ code: "INVITATION_INACTIVE" });
      return publicInvitation(invitation, changedAt);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/admin/invitations/:id/reissue",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const changedAt = now();
      const actor = await memberForRequest(request, db, changedAt);
      if (actor?.role !== "super_admin") {
        return reply.code(403).send({ code: "FORBIDDEN" });
      }
      const original = (
        await db
          .select({ email: invitations.email })
          .from(invitations)
          .where(eq(invitations.id, request.params.id))
          .limit(1)
      )[0];
      if (!original) return reply.code(404).send({ code: "INVITATION_NOT_FOUND" });

      const invitation = await issueInvitation(
        db,
        original.email,
        actor.id,
        changedAt,
      );
      return reply.code(201).send(publicInvitation(invitation, changedAt));
    },
  );
}
