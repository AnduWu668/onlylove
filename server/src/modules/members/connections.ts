import { desc, inArray } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db.js";
import { matchCriteriaVersions, members } from "./schema.js";

const fields = {
  id: members.id,
  email: members.email,
  nickname: members.nickname,
  birthDate: members.birthDate,
  heightCm: members.heightCm,
  city: members.city,
  occupation: members.occupation,
  role: members.role,
  deletedAt: members.deletedAt,
  suspendedUntil: members.suspendedUntil,
};

export class ConnectionMembers {
  constructor(private readonly db: Database) {}

  async byIds(
    memberIds: string[],
    database: Database | DatabaseTransaction = this.db,
  ) {
    if (!memberIds.length) return [];
    return database
      .select(fields)
      .from(members)
      .where(inArray(members.id, memberIds));
  }

  async eligiblePair(
    input: {
      requesterMemberId: string;
      recipientMemberId: string;
      requesterCriteriaVersionId: string;
      recipientCriteriaVersionId: string;
    },
    at: Date,
    database: Database | DatabaseTransaction = this.db,
  ) {
    const memberIds = [input.requesterMemberId, input.recipientMemberId];
    const memberRows = await this.byIds(memberIds, database);
    const criteriaRows = await database
      .select({
        id: matchCriteriaVersions.id,
        memberId: matchCriteriaVersions.memberId,
      })
      .from(matchCriteriaVersions)
      .where(inArray(matchCriteriaVersions.memberId, memberIds))
      .orderBy(desc(matchCriteriaVersions.version));
    const latestCriteria = new Map<string, string>();
    for (const criteria of criteriaRows) {
      if (!latestCriteria.has(criteria.memberId)) {
        latestCriteria.set(criteria.memberId, criteria.id);
      }
    }
    if (
      memberRows.length !== 2 ||
      memberRows.some(
        (member) =>
          member.role !== "member" ||
          member.deletedAt ||
          (member.suspendedUntil && member.suspendedUntil > at),
      ) ||
      latestCriteria.get(input.requesterMemberId) !==
        input.requesterCriteriaVersionId ||
      latestCriteria.get(input.recipientMemberId) !==
        input.recipientCriteriaVersionId
    ) {
      return undefined;
    }
    const byId = new Map(memberRows.map((member) => [member.id, member]));
    return {
      requester: byId.get(input.requesterMemberId)!,
      recipient: byId.get(input.recipientMemberId)!,
    };
  }
}
