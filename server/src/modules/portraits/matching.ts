import { eq } from "drizzle-orm";
import type { Database } from "../../db.js";
import {
  portraitCalibrationAnswers,
  portraitCalibrationScenarios,
  portraitMemberStates,
  portraitVersions,
} from "./schema.js";

export interface PublishedMatchingPortrait {
  version: typeof portraitVersions.$inferSelect;
  calibration: {
    rating: typeof portraitCalibrationAnswers.$inferSelect.rating;
    criticalFabrication: boolean;
  }[];
}

export class MatchingPortraits {
  constructor(private readonly db: Database) {}

  async published(memberId: string): Promise<PublishedMatchingPortrait | undefined> {
    const state = (
      await this.db
        .select({ publishedVersionId: portraitMemberStates.publishedVersionId })
        .from(portraitMemberStates)
        .where(eq(portraitMemberStates.memberId, memberId))
        .limit(1)
    )[0];
    if (!state?.publishedVersionId) return undefined;
    const version = (
      await this.db
        .select()
        .from(portraitVersions)
        .where(eq(portraitVersions.id, state.publishedVersionId))
        .limit(1)
    )[0];
    if (!version) return undefined;
    const calibration = await this.db
      .select({
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
      .where(eq(portraitCalibrationScenarios.portraitVersionId, version.id));
    return { version, calibration };
  }
}
