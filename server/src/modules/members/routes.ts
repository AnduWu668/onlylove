import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "../../db.js";
import type { Mailer } from "./mailer.js";
import {
  invitations,
  matchCriteriaVersions,
  members,
  otpChallenges,
  sessions,
} from "./schema.js";
import type { Gender, RequirementMode } from "./schema.js";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_LENGTH = 20;
const PASSWORD_KEY_LENGTH = 64;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const DUMMY_PASSWORD_HASH = `scrypt$${SCRYPT_COST}$${SCRYPT_BLOCK_SIZE}$${SCRYPT_PARALLELIZATION}$${"00".repeat(16)}$${"00".repeat(PASSWORD_KEY_LENGTH)}`;

interface ProfileUpdate {
  profile: {
    nickname: string;
    birthDate: string;
    gender: Gender;
    heightCm: number;
    city: string;
    occupation: string;
  };
  matchCriteria: {
    desiredGender: Gender;
    ageMinimum: number | null;
    ageMaximum: number | null;
    ageMode: RequirementMode | null;
    heightMinimumCm: number | null;
    heightMaximumCm: number | null;
    heightMode: RequirementMode | null;
    acceptableCities: string[];
    occupationRequirement: string | null;
    occupationMode: RequirementMode | null;
  };
}

const emailSchema = {
  type: "object",
  additionalProperties: false,
  required: ["email"],
  properties: { email: { type: "string", format: "email", maxLength: 320 } },
} as const;

const passwordSchema = {
  type: "object",
  additionalProperties: false,
  required: ["password"],
  properties: {
    password: { type: "string", minLength: 1, maxLength: PASSWORD_MAX_LENGTH },
  },
} as const;

const passwordLoginSchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password"],
  properties: {
    email: { type: "string", format: "email", maxLength: 320 },
    password: { type: "string", minLength: 1, maxLength: PASSWORD_MAX_LENGTH },
  },
} as const;

const nullableInteger = (minimum: number) => ({
  type: ["integer", "null"],
  minimum,
  maximum: POSTGRES_INTEGER_MAX,
});

const profileUpdateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["profile", "matchCriteria"],
  properties: {
    profile: {
      type: "object",
      additionalProperties: false,
      required: [
        "nickname",
        "birthDate",
        "gender",
        "heightCm",
        "city",
        "occupation",
      ],
      properties: {
        nickname: { type: "string", minLength: 1, maxLength: 40 },
        birthDate: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
        gender: { type: "string", enum: ["female", "male"] },
        heightCm: {
          type: "integer",
          minimum: 1,
          maximum: POSTGRES_INTEGER_MAX,
        },
        city: { type: "string", minLength: 1, maxLength: 60 },
        occupation: { type: "string", minLength: 1, maxLength: 80 },
      },
    },
    matchCriteria: {
      type: "object",
      additionalProperties: false,
      required: [
        "desiredGender",
        "ageMinimum",
        "ageMaximum",
        "ageMode",
        "heightMinimumCm",
        "heightMaximumCm",
        "heightMode",
        "acceptableCities",
        "occupationRequirement",
        "occupationMode",
      ],
      properties: {
        desiredGender: { type: "string", enum: ["female", "male"] },
        ageMinimum: nullableInteger(18),
        ageMaximum: nullableInteger(18),
        ageMode: { type: ["string", "null"], enum: ["required", "preferred", null] },
        heightMinimumCm: nullableInteger(1),
        heightMaximumCm: nullableInteger(1),
        heightMode: { type: ["string", "null"], enum: ["required", "preferred", null] },
        acceptableCities: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 60 },
        },
        occupationRequirement: { type: ["string", "null"], maxLength: 100 },
        occupationMode: { type: ["string", "null"], enum: ["required", "preferred", null] },
      },
    },
  },
} as const;

type Member = typeof members.$inferSelect;

export interface MembersOptions {
  db: Database;
  mailer: Mailer;
  now: () => Date;
  otpSecret: string;
  production: boolean;
  recheckRecommendations?: (memberId: string) => Promise<void>;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function hashSessionToken(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function derivePassword(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      PASSWORD_KEY_LENGTH,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: 64 * 1024 * 1024,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derivePassword(password, salt);
  return [
    "scrypt",
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
    salt.toString("hex"),
    key.toString("hex"),
  ].join("$");
}

async function passwordMatches(encoded: string, password: string) {
  const [algorithm, cost, blockSize, parallelization, saltHex, keyHex] =
    encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    Number(cost) !== SCRYPT_COST ||
    Number(blockSize) !== SCRYPT_BLOCK_SIZE ||
    Number(parallelization) !== SCRYPT_PARALLELIZATION ||
    !/^[0-9a-f]{32}$/.test(saltHex ?? "") ||
    !/^[0-9a-f]{128}$/.test(keyHex ?? "")
  ) {
    return false;
  }
  const actual = await derivePassword(password, Buffer.from(saltHex!, "hex"));
  const expected = Buffer.from(keyHex!, "hex");
  return timingSafeEqual(actual, expected);
}

function validPassword(password: string) {
  return (
    password.length >= PASSWORD_MIN_LENGTH &&
    password.length <= PASSWORD_MAX_LENGTH
  );
}

function setSessionCookie(
  reply: FastifyReply,
  sessionToken: string,
  production: boolean,
) {
  reply.setCookie("onlylove_session", sessionToken, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: production,
    maxAge: 30 * 24 * 60 * 60,
  });
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
  return {
    email: member.email,
    role: member.role,
    suspendedUntil: member.suspendedUntil?.toISOString() ?? null,
  };
}

export function publicProfile(member: Member) {
  return {
    nickname: member.nickname ?? "",
    birthDate: member.birthDate ?? "",
    gender: member.gender ?? "",
    heightCm: member.heightCm,
    city: member.city ?? "",
    occupation: member.occupation ?? "",
  };
}

export async function candidatePublicProfileById(
  memberId: string,
  db: Database,
) {
  const member = (
    await db
      .select({
        nickname: members.nickname,
        heightCm: members.heightCm,
        city: members.city,
        occupation: members.occupation,
      })
      .from(members)
      .where(
        and(
          eq(members.id, memberId),
          eq(members.role, "member"),
          isNull(members.deletedAt),
        ),
      )
      .limit(1)
  )[0];
  return member
    ? {
        nickname: member.nickname ?? "",
        heightCm: member.heightCm,
        city: member.city ?? "",
        occupation: member.occupation ?? "",
      }
    : undefined;
}

function publicMatchCriteria(
  criteria: typeof matchCriteriaVersions.$inferSelect,
) {
  return {
    version: criteria.version,
    desiredGender: criteria.desiredGender,
    ageMinimum: criteria.ageMinimum,
    ageMaximum: criteria.ageMaximum,
    ageMode: criteria.ageMode,
    heightMinimumCm: criteria.heightMinimumCm,
    heightMaximumCm: criteria.heightMaximumCm,
    heightMode: criteria.heightMode,
    acceptableCities: criteria.acceptableCities,
    occupationRequirement: criteria.occupationRequirement,
    occupationMode: criteria.occupationMode,
  };
}

function normalizeProfileUpdate(body: ProfileUpdate): ProfileUpdate {
  return {
    profile: {
      ...body.profile,
      nickname: body.profile.nickname.trim(),
      city: body.profile.city.trim(),
      occupation: body.profile.occupation.trim(),
    },
    matchCriteria: {
      ...body.matchCriteria,
      acceptableCities: body.matchCriteria.acceptableCities.map((city) =>
        city.trim(),
      ),
      occupationRequirement:
        body.matchCriteria.occupationRequirement?.trim() ?? null,
    },
  };
}

function validateRange(
  minimum: number | null,
  maximum: number | null,
  mode: RequirementMode | null,
) {
  return minimum === null && maximum === null && mode === null
    ? true
    : minimum !== null &&
        maximum !== null &&
        minimum <= maximum &&
        (mode === "required" || mode === "preferred");
}

function invalidProfileUpdate(body: ProfileUpdate, now: Date) {
  const { profile, matchCriteria } = body;
  if (!profile.nickname || profile.nickname.length > 40) {
    return { code: "INVALID_PROFILE", field: "nickname" };
  }
  if (!isAdult(profile.birthDate, now)) {
    return { code: "INVALID_PROFILE", field: "birthDate" };
  }
  if (
    !Number.isInteger(profile.heightCm) ||
    profile.heightCm < 1 ||
    profile.heightCm > POSTGRES_INTEGER_MAX
  ) {
    return { code: "INVALID_PROFILE", field: "heightCm" };
  }
  if (!profile.city || profile.city.length > 60) {
    return { code: "INVALID_PROFILE", field: "city" };
  }
  if (!profile.occupation || profile.occupation.length > 80) {
    return { code: "INVALID_PROFILE", field: "occupation" };
  }
  if (matchCriteria.desiredGender === profile.gender) {
    return { code: "INVALID_MATCH_CRITERIA", field: "desiredGender" };
  }
  if (!validateRange(
    matchCriteria.ageMinimum,
    matchCriteria.ageMaximum,
    matchCriteria.ageMode,
  )) {
    return { code: "INVALID_MATCH_CRITERIA", field: "ageRange" };
  }
  if (!validateRange(
    matchCriteria.heightMinimumCm,
    matchCriteria.heightMaximumCm,
    matchCriteria.heightMode,
  )) {
    return { code: "INVALID_MATCH_CRITERIA", field: "heightRange" };
  }
  if (
    matchCriteria.acceptableCities.length === 0 ||
    matchCriteria.acceptableCities.some((city) => !city || city.length > 60) ||
    new Set(matchCriteria.acceptableCities).size !==
      matchCriteria.acceptableCities.length
  ) {
    return { code: "INVALID_MATCH_CRITERIA", field: "acceptableCities" };
  }
  const occupationIsUnlimited =
    matchCriteria.occupationRequirement === null &&
    matchCriteria.occupationMode === null;
  const occupationIsSpecified =
    Boolean(matchCriteria.occupationRequirement) &&
    (matchCriteria.occupationMode === "required" ||
      matchCriteria.occupationMode === "preferred");
  if (!occupationIsUnlimited && !occupationIsSpecified) {
    return { code: "INVALID_MATCH_CRITERIA", field: "occupationRequirement" };
  }
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
    .onConflictDoNothing({ target: members.email });
}

async function sessionForRequest(
  request: FastifyRequest,
  db: Database,
  now: Date,
) {
  const token = request.cookies.onlylove_session;
  if (!token) return undefined;

  const rows = await db
    .select({ member: members, session: sessions })
    .from(sessions)
    .innerJoin(members, eq(sessions.memberId, members.id))
    .where(
      and(
        eq(sessions.tokenHash, hashSessionToken(token)),
        gt(sessions.expiresAt, now),
        isNull(members.deletedAt),
      ),
    )
    .limit(1);
  return rows[0];
}

export async function authenticatedMemberForRequest(
  request: FastifyRequest,
  db: Database,
  now: Date,
) {
  const current = await sessionForRequest(request, db, now);
  if (
    !current ||
    current.session.passwordSetupRequired ||
    !current.member.passwordHash
  ) {
    return undefined;
  }
  return current.member;
}

export async function memberForRequest(
  request: FastifyRequest,
  db: Database,
  now: Date,
) {
  const member = await authenticatedMemberForRequest(request, db, now);
  if (
    member?.role === "member" &&
    member.suspendedUntil &&
    member.suspendedUntil > now
  ) {
    return undefined;
  }
  return member;
}

export async function interviewContextForMember(member: Member, db: Database) {
  const criteria = (
    await db
      .select()
      .from(matchCriteriaVersions)
      .where(eq(matchCriteriaVersions.memberId, member.id))
      .orderBy(desc(matchCriteriaVersions.version))
      .limit(1)
  )[0];
  return {
    memberProfile: publicProfile(member),
    matchCriteria: criteria ? publicMatchCriteria(criteria) : null,
  };
}

export async function superAdminForRequest(
  request: FastifyRequest,
  db: Database,
  now: Date,
) {
  const member = await memberForRequest(request, db, now);
  return member?.role === "super_admin" ? member : undefined;
}

export async function adminForRequest(
  request: FastifyRequest,
  db: Database,
  now: Date,
) {
  const member = await memberForRequest(request, db, now);
  if (member?.role !== "admin" && member?.role !== "super_admin") {
    return undefined;
  }
  return { ...member, role: member.role };
}

export async function activeAdminById(id: string, db: Database) {
  return (
    await db
      .select({ id: members.id, role: members.role })
      .from(members)
      .where(
        and(
          eq(members.id, id),
          inArray(members.role, ["admin", "super_admin"]),
          isNull(members.deletedAt),
        ),
      )
      .limit(1)
  )[0];
}

export function registerMembersRoutes(
  app: FastifyInstance,
  {
    db,
    mailer,
    now,
    otpSecret,
    production,
    recheckRecommendations,
  }: MembersOptions,
) {
  app.post<{ Body: { email: string; password: string } }>(
    "/api/auth/login",
    { schema: { body: passwordLoginSchema } },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      const signedInAt = now();
      const member = (
        await db
          .select()
          .from(members)
          .where(and(eq(members.email, email), isNull(members.deletedAt)))
          .limit(1)
      )[0];
      const matches = await passwordMatches(
        member?.passwordHash ?? DUMMY_PASSWORD_HASH,
        request.body.password,
      );
      if (!member?.passwordHash || !matches) {
        return reply.code(401).send({ code: "INVALID_CREDENTIALS" });
      }

      const sessionToken = randomUUID() + randomUUID();
      await db.insert(sessions).values({
        id: randomUUID(),
        memberId: member.id,
        tokenHash: hashSessionToken(sessionToken),
        passwordSetupRequired: false,
        createdAt: signedInAt,
        expiresAt: new Date(signedInAt.getTime() + 30 * 24 * 60 * 60_000),
      });
      setSessionCookie(reply, sessionToken, production);
      return {
        member: publicMember(member),
        requiresPasswordSetup: false,
      };
    },
  );

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
      try {
        await mailer.sendOtp(email, challenge.code);
      } catch (error) {
        await db
          .delete(otpChallenges)
          .where(eq(otpChallenges.id, challenge.id));
        throw error;
      }
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
          tokenHash: hashSessionToken(sessionToken),
          passwordSetupRequired: true,
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

      setSessionCookie(reply, sessionToken, production);
      return {
        member: publicMember(result.member),
        requiresPasswordSetup: true,
      };
    },
  );

  app.put<{ Body: { password: string } }>(
    "/api/auth/password",
    { schema: { body: passwordSchema } },
    async (request, reply) => {
      const current = await sessionForRequest(request, db, now());
      if (!current) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      if (
        !current.session.passwordSetupRequired &&
        current.member.passwordHash
      ) {
        return reply.code(403).send({ code: "PASSWORD_RESET_REQUIRED" });
      }
      if (!validPassword(request.body.password)) {
        return reply.code(400).send({ code: "INVALID_PASSWORD" });
      }

      const passwordHash = await hashPassword(request.body.password);
      await db.transaction(async (transaction) => {
        await transaction
          .update(members)
          .set({ passwordHash })
          .where(eq(members.id, current.member.id));
        await transaction
          .delete(sessions)
          .where(
            and(
              eq(sessions.memberId, current.member.id),
              ne(sessions.id, current.session.id),
            ),
          );
        await transaction
          .update(sessions)
          .set({ passwordSetupRequired: false })
          .where(eq(sessions.id, current.session.id));
      });
      return {
        member: publicMember(current.member),
        requiresPasswordSetup: false,
      };
    },
  );

  app.get("/api/session", async (request, reply) => {
    const current = await sessionForRequest(request, db, now());
    if (!current) return reply.code(401).send({ code: "UNAUTHENTICATED" });
    return {
      member: publicMember(current.member),
      requiresPasswordSetup:
        current.session.passwordSetupRequired || !current.member.passwordHash,
    };
  });

  app.get("/api/member/profile", async (request, reply) => {
    const member = await memberForRequest(request, db, now());
    if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
    const currentCriteria = (
      await db
        .select()
        .from(matchCriteriaVersions)
        .where(eq(matchCriteriaVersions.memberId, member.id))
        .orderBy(desc(matchCriteriaVersions.version))
        .limit(1)
    )[0];
    return {
      profile: publicProfile(member),
      matchCriteria: currentCriteria
        ? publicMatchCriteria(currentCriteria)
        : null,
    };
  });

  app.put<{ Body: ProfileUpdate }>(
    "/api/member/profile",
    { schema: { body: profileUpdateSchema } },
    async (request, reply) => {
      const savedAt = now();
      const member = await memberForRequest(request, db, savedAt);
      if (!member) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      const body = normalizeProfileUpdate(request.body);
      const invalid = invalidProfileUpdate(body, savedAt);
      if (invalid) return reply.code(400).send(invalid);

      const criteria = await db.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext(${member.id}))`,
        );
        const current = (
          await transaction
            .select({ version: matchCriteriaVersions.version })
            .from(matchCriteriaVersions)
            .where(eq(matchCriteriaVersions.memberId, member.id))
            .orderBy(desc(matchCriteriaVersions.version))
            .limit(1)
        )[0];
        await transaction
          .update(members)
          .set(body.profile)
          .where(eq(members.id, member.id));
        return (
          await transaction
            .insert(matchCriteriaVersions)
            .values({
              id: randomUUID(),
              memberId: member.id,
              version: (current?.version ?? 0) + 1,
              ...body.matchCriteria,
              createdAt: savedAt,
            })
            .returning()
        )[0]!;
      });
      try {
        await recheckRecommendations?.(member.id);
      } catch (error) {
        request.log.error(
          { err: error, memberId: member.id },
          "Recommendation recheck after profile save failed",
        );
      }
      return {
        profile: body.profile,
        matchCriteria: publicMatchCriteria(criteria),
      };
    },
  );

  app.delete("/api/session", async (request, reply) => {
    const token = request.cookies.onlylove_session;
    if (token) {
      await db
        .delete(sessions)
        .where(eq(sessions.tokenHash, hashSessionToken(token)));
    }
    reply.clearCookie("onlylove_session", { path: "/" });
    return reply.code(204).send();
  });

  app.get("/api/admin/invitations", async (request, reply) => {
    const requestedAt = now();
    const actor = await superAdminForRequest(request, db, requestedAt);
    if (!actor) {
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
      const actor = await superAdminForRequest(request, db, now());
      if (!actor) {
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
      const actor = await superAdminForRequest(request, db, changedAt);
      if (!actor) {
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
      const actor = await superAdminForRequest(request, db, changedAt);
      if (!actor) {
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
