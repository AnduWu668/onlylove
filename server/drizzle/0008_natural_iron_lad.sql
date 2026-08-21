CREATE TABLE "portrait_calibration_answers" (
	"scenario_id" uuid PRIMARY KEY NOT NULL,
	"rating" varchar(16) NOT NULL,
	"correction" text NOT NULL,
	"critical_fabrication" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portrait_calibration_answers" ADD CONSTRAINT "portrait_calibration_answers_scenario_id_portrait_calibration_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."portrait_calibration_scenarios"("id") ON DELETE no action ON UPDATE no action;