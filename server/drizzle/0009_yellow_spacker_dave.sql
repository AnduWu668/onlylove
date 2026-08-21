ALTER TABLE "portrait_calibration_scenarios" ALTER COLUMN "prediction" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "profile_version_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "calibration_scenario_id" uuid;