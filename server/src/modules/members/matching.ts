import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import { matchCriteriaVersions, members } from "./schema.js";

type MatchingCriteria = Pick<
  typeof matchCriteriaVersions.$inferSelect,
  | "id"
  | "version"
  | "desiredGender"
  | "ageMinimum"
  | "ageMaximum"
  | "ageMode"
  | "heightMinimumCm"
  | "heightMaximumCm"
  | "heightMode"
  | "acceptableCities"
  | "occupationRequirement"
  | "occupationMode"
>;

export interface MatchingMember {
  id: string;
  nickname: string | null;
  birthDate: string | null;
  gender: "female" | "male" | null;
  heightCm: number | null;
  city: string | null;
  occupation: string | null;
  criteria: MatchingCriteria | undefined;
}

const memberFields = {
  id: members.id,
  nickname: members.nickname,
  birthDate: members.birthDate,
  gender: members.gender,
  heightCm: members.heightCm,
  city: members.city,
  occupation: members.occupation,
};

const criteriaFields = {
  id: matchCriteriaVersions.id,
  memberId: matchCriteriaVersions.memberId,
  version: matchCriteriaVersions.version,
  desiredGender: matchCriteriaVersions.desiredGender,
  ageMinimum: matchCriteriaVersions.ageMinimum,
  ageMaximum: matchCriteriaVersions.ageMaximum,
  ageMode: matchCriteriaVersions.ageMode,
  heightMinimumCm: matchCriteriaVersions.heightMinimumCm,
  heightMaximumCm: matchCriteriaVersions.heightMaximumCm,
  heightMode: matchCriteriaVersions.heightMode,
  acceptableCities: matchCriteriaVersions.acceptableCities,
  occupationRequirement: matchCriteriaVersions.occupationRequirement,
  occupationMode: matchCriteriaVersions.occupationMode,
};

export class MatchingMembers {
  constructor(private readonly db: Database) {}

  async byIds(
    memberIds: string[],
    database: Database | DatabaseTransaction = this.db,
  ): Promise<MatchingMember[]> {
    if (!memberIds.length) return [];
    const rows = await database
      .select(memberFields)
      .from(members)
      .where(
        and(
          inArray(members.id, memberIds),
          eq(members.role, "member"),
          isNull(members.deletedAt),
        ),
      );
    if (!rows.length) return [];
    const criteria = await database
      .select(criteriaFields)
      .from(matchCriteriaVersions)
      .where(inArray(matchCriteriaVersions.memberId, rows.map(({ id }) => id)))
      .orderBy(desc(matchCriteriaVersions.version));
    const latest = new Map<string, MatchingCriteria>();
    for (const { memberId, ...value } of criteria) {
      if (!latest.has(memberId)) latest.set(memberId, value);
    }
    return rows.map((member) => ({
      ...member,
      criteria: latest.get(member.id),
    }));
  }

  candidates(excludingMemberId: string) {
    return this.db
      .select({ id: members.id })
      .from(members)
      .where(
        and(
          ne(members.id, excludingMemberId),
          eq(members.role, "member"),
          isNull(members.deletedAt),
        ),
      );
  }
}
