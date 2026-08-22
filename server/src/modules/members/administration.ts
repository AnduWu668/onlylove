import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import { normalizeEmail } from "./routes.js";
import {
  administrationAudits,
  matchCriteriaVersions,
  members,
  sessions,
  type AdministrationAuditAction,
} from "./schema.js";

export interface AdministrationAuditInput {
  actorMemberId: string;
  action: AdministrationAuditAction;
  createdAt: Date;
  targetMemberId?: string | null;
  resourceId?: string | null;
  details?: Record<string, unknown>;
}

export class MembersAdministration {
  constructor(private readonly db: Database) {}

  recordAudit(
    input: AdministrationAuditInput,
    database: Database | DatabaseTransaction = this.db,
  ) {
    return database.insert(administrationAudits).values({
      id: randomUUID(),
      targetMemberId: null,
      resourceId: null,
      details: {},
      ...input,
    });
  }

  async administrators() {
    return this.db
      .select()
      .from(members)
      .where(eq(members.role, "admin"))
      .orderBy(desc(members.createdAt));
  }

  createAdministrator(email: string, actorMemberId: string, createdAt: Date) {
    return this.db.transaction(async (transaction) => {
      const administrator = (
        await transaction
          .insert(members)
          .values({
            id: randomUUID(),
            email: normalizeEmail(email),
            role: "admin",
            createdAt,
          })
          .onConflictDoNothing({ target: members.email })
          .returning()
      )[0];
      if (!administrator) return undefined;
      await this.recordAudit(
        {
          actorMemberId,
          targetMemberId: administrator.id,
          action: "administrator_created",
          createdAt,
          details: { email: administrator.email },
        },
        transaction,
      );
      return administrator;
    });
  }

  setAdministratorActive(
    id: string,
    active: boolean,
    actorMemberId: string,
    changedAt: Date,
  ) {
    return this.db.transaction(async (transaction) => {
      const administrator = (
        await transaction
          .update(members)
          .set({ deletedAt: active ? null : changedAt })
          .where(
            and(
              eq(members.id, id),
              eq(members.role, "admin"),
              isNull(members.purgedAt),
            ),
          )
          .returning()
      )[0];
      if (!administrator) return undefined;
      if (!active) {
        await transaction
          .delete(sessions)
          .where(eq(sessions.memberId, administrator.id));
      }
      await this.recordAudit(
        {
          actorMemberId,
          targetMemberId: administrator.id,
          action: active
            ? "administrator_activated"
            : "administrator_deactivated",
          createdAt: changedAt,
          details: { email: administrator.email },
        },
        transaction,
      );
      return administrator;
    });
  }

  memberDirectory() {
    return this.db
      .select({
        id: members.id,
        email: members.email,
        nickname: members.nickname,
        createdAt: members.createdAt,
        suspendedUntil: members.suspendedUntil,
        deletedAt: members.deletedAt,
      })
      .from(members)
      .where(and(eq(members.role, "member"), isNull(members.purgedAt)))
      .orderBy(desc(members.createdAt));
  }

  async memberDetail(id: string) {
    const member = (
      await this.db
        .select({
          id: members.id,
          email: members.email,
          role: members.role,
          birthDate: members.birthDate,
          nickname: members.nickname,
          gender: members.gender,
          heightCm: members.heightCm,
          city: members.city,
          occupation: members.occupation,
          createdAt: members.createdAt,
          suspendedUntil: members.suspendedUntil,
          deletedAt: members.deletedAt,
        })
        .from(members)
        .where(and(eq(members.id, id), eq(members.role, "member")))
        .limit(1)
    )[0];
    if (!member) return undefined;
    const matchCriteria = (
      await this.db
        .select()
        .from(matchCriteriaVersions)
        .where(eq(matchCriteriaVersions.memberId, id))
        .orderBy(desc(matchCriteriaVersions.version))
        .limit(1)
    )[0];
    return { member, matchCriteria: matchCriteria ?? null };
  }

  async metrics(at: Date) {
    const [memberRows, criteriaRows] = await Promise.all([
      this.db.select().from(members).where(eq(members.role, "member")),
      this.db
        .select({ memberId: matchCriteriaVersions.memberId })
        .from(matchCriteriaVersions),
    ]);
    const criteriaMembers = new Set(criteriaRows.map(({ memberId }) => memberId));
    const activeCompleteMembers = memberRows.filter(
      (member) =>
        !member.deletedAt &&
        !member.purgedAt &&
        (!member.suspendedUntil || member.suspendedUntil <= at) &&
        member.birthDate &&
        member.nickname &&
        member.gender &&
        member.city &&
        member.occupation,
    );
    return {
      registered: memberRows.filter((member) => !member.purgedAt).length,
      profileCompleted: activeCompleteMembers.length,
      structuredCriteriaCompleted: new Set(criteriaRows.map(({ memberId }) => memberId))
        .size,
      recommendationReadyMemberIds: activeCompleteMembers
        .filter((member) => criteriaMembers.has(member.id))
        .map(({ id }) => id),
    };
  }

  audits() {
    return this.db
      .select()
      .from(administrationAudits)
      .orderBy(desc(administrationAudits.createdAt));
  }
}
