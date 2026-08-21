ALTER TABLE "agent_jobs" ALTER COLUMN "conversation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_jobs" ALTER COLUMN "input_message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "conversation_id" DROP NOT NULL;--> statement-breakpoint
CREATE TEMP TABLE "calibration_conversations_to_remove" AS
	SELECT DISTINCT "conversation_id" AS "id"
	FROM "agent_jobs"
	WHERE "task" = 'reply_as_twin'
		AND "profile_version_id" IS NOT NULL
		AND "calibration_scenario_id" IS NOT NULL
		AND "conversation_id" IS NOT NULL;--> statement-breakpoint
UPDATE "agent_jobs" SET "input_message_id" = NULL
	WHERE "task" = 'reply_as_twin'
		AND "profile_version_id" IS NOT NULL
		AND "calibration_scenario_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "conversation_messages" WHERE "conversation_id" IN (
	SELECT "id" FROM "calibration_conversations_to_remove"
);--> statement-breakpoint
UPDATE "agent_runs" SET "conversation_id" = NULL WHERE "job_id" IN (
	SELECT "id" FROM "agent_jobs"
	WHERE "task" = 'reply_as_twin'
		AND "profile_version_id" IS NOT NULL
		AND "calibration_scenario_id" IS NOT NULL
);--> statement-breakpoint
UPDATE "agent_jobs" SET "conversation_id" = NULL
	WHERE "task" = 'reply_as_twin'
		AND "profile_version_id" IS NOT NULL
		AND "calibration_scenario_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "conversations" WHERE "id" IN (
	SELECT "id" FROM "calibration_conversations_to_remove"
);--> statement-breakpoint
DROP TABLE "calibration_conversations_to_remove";
