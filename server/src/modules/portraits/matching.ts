import { eq, inArray } from "drizzle-orm";
import type { Database } from "../../db.js";
import type { MatchProfile } from "./schema.js";
import {
  portraitCalibrationAnswers,
  portraitCalibrationScenarios,
  portraitMemberStates,
  portraitVersions,
} from "./schema.js";

export interface PublishedMatchingPortrait {
  version: {
    id: string;
    memberId: string;
    version: number;
    matchProfile: MatchProfile;
  };
  calibration: {
    rating: typeof portraitCalibrationAnswers.$inferSelect.rating;
    criticalFabrication: boolean;
  }[];
}

export class MatchingPortraits {
  constructor(private readonly db: Database) {}

  async publishedFor(memberIds: string[]) {
    const result = new Map<string, PublishedMatchingPortrait>();
    if (!memberIds.length) return result;
    const states = await this.db
      .select({
        memberId: portraitMemberStates.memberId,
        publishedVersionId: portraitMemberStates.publishedVersionId,
      })
      .from(portraitMemberStates)
      .where(inArray(portraitMemberStates.memberId, memberIds));
    const versionIds = states.flatMap(({ publishedVersionId }) =>
      publishedVersionId ? [publishedVersionId] : [],
    );
    if (!versionIds.length) return result;
    const [versions, answers] = await Promise.all([
      this.db
        .select({
          id: portraitVersions.id,
          memberId: portraitVersions.memberId,
          version: portraitVersions.version,
          matchProfile: portraitVersions.matchProfile,
        })
        .from(portraitVersions)
        .where(inArray(portraitVersions.id, versionIds)),
      this.db
        .select({
          portraitVersionId: portraitCalibrationScenarios.portraitVersionId,
          rating: portraitCalibrationAnswers.rating,
          criticalFabrication: portraitCalibrationAnswers.criticalFabrication,
        })
        .from(portraitCalibrationScenarios)
        .innerJoin(
          portraitCalibrationAnswers,
          eq(
            portraitCalibrationAnswers.scenarioId,
            portraitCalibrationScenarios.id,
          ),
        )
        .where(
          inArray(portraitCalibrationScenarios.portraitVersionId, versionIds),
        ),
    ]);
    const calibration = new Map<
      string,
      PublishedMatchingPortrait["calibration"]
    >();
    for (const answer of answers) {
      const values = calibration.get(answer.portraitVersionId) ?? [];
      values.push({
        rating: answer.rating,
        criticalFabrication: answer.criticalFabrication,
      });
      calibration.set(answer.portraitVersionId, values);
    }
    const byId = new Map(versions.map((version) => [version.id, version]));
    for (const state of states) {
      if (!state.publishedVersionId) continue;
      const version = byId.get(state.publishedVersionId);
      if (version) {
        result.set(state.memberId, {
          version,
          calibration: calibration.get(version.id) ?? [],
        });
      }
    }
    return result;
  }
}
