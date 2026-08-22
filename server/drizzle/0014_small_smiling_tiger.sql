CREATE TABLE "candidate_recommendations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"candidate_member_id" uuid NOT NULL,
	"pair_evaluation_id" uuid NOT NULL,
	"member_portrait_version_id" uuid NOT NULL,
	"candidate_portrait_version_id" uuid NOT NULL,
	"member_criteria_version_id" uuid NOT NULL,
	"candidate_criteria_version_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" varchar(16) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matching_followup_questions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"pair_evaluation_id" uuid NOT NULL,
	"question_key" varchar(80) NOT NULL,
	"question" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matching_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"candidate_capacity" integer NOT NULL,
	"minimum_reciprocal_score" double precision NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matching_settings_audits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" uuid NOT NULL,
	"previous_capacity" integer NOT NULL,
	"previous_minimum_score" double precision NOT NULL,
	"candidate_capacity" integer NOT NULL,
	"minimum_reciprocal_score" double precision NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_blocks" (
	"blocker_member_id" uuid NOT NULL,
	"blocked_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "member_blocks_blocker_member_id_blocked_member_id_pk" PRIMARY KEY("blocker_member_id","blocked_member_id")
);
--> statement-breakpoint
CREATE TABLE "member_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_a_id" uuid NOT NULL,
	"member_b_id" uuid NOT NULL,
	"status" varchar(16) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pair_evaluations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_a_id" uuid NOT NULL,
	"member_b_id" uuid NOT NULL,
	"portrait_version_a_id" uuid NOT NULL,
	"portrait_version_b_id" uuid NOT NULL,
	"criteria_version_a_id" uuid NOT NULL,
	"criteria_version_b_id" uuid NOT NULL,
	"rubric_version" varchar(80) NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendation_daily_runs" (
	"member_id" uuid NOT NULL,
	"run_date" date NOT NULL,
	"status" varchar(16) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "recommendation_daily_runs_member_id_run_date_pk" PRIMARY KEY("member_id","run_date")
);
--> statement-breakpoint
ALTER TABLE "candidate_recommendations" ADD CONSTRAINT "candidate_recommendations_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_recommendations" ADD CONSTRAINT "candidate_recommendations_candidate_member_id_members_id_fk" FOREIGN KEY ("candidate_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_recommendations" ADD CONSTRAINT "candidate_recommendations_pair_evaluation_id_pair_evaluations_id_fk" FOREIGN KEY ("pair_evaluation_id") REFERENCES "public"."pair_evaluations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_recommendations" ADD CONSTRAINT "candidate_recommendations_member_portrait_version_id_portrait_versions_id_fk" FOREIGN KEY ("member_portrait_version_id") REFERENCES "public"."portrait_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_recommendations" ADD CONSTRAINT "candidate_recommendations_candidate_portrait_version_id_portrait_versions_id_fk" FOREIGN KEY ("candidate_portrait_version_id") REFERENCES "public"."portrait_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_recommendations" ADD CONSTRAINT "candidate_recommendations_member_criteria_version_id_match_criteria_versions_id_fk" FOREIGN KEY ("member_criteria_version_id") REFERENCES "public"."match_criteria_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_recommendations" ADD CONSTRAINT "candidate_recommendations_candidate_criteria_version_id_match_criteria_versions_id_fk" FOREIGN KEY ("candidate_criteria_version_id") REFERENCES "public"."match_criteria_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching_followup_questions" ADD CONSTRAINT "matching_followup_questions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching_followup_questions" ADD CONSTRAINT "matching_followup_questions_pair_evaluation_id_pair_evaluations_id_fk" FOREIGN KEY ("pair_evaluation_id") REFERENCES "public"."pair_evaluations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching_settings" ADD CONSTRAINT "matching_settings_updated_by_members_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching_settings_audits" ADD CONSTRAINT "matching_settings_audits_actor_id_members_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_blocks" ADD CONSTRAINT "member_blocks_blocker_member_id_members_id_fk" FOREIGN KEY ("blocker_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_blocks" ADD CONSTRAINT "member_blocks_blocked_member_id_members_id_fk" FOREIGN KEY ("blocked_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_connections" ADD CONSTRAINT "member_connections_member_a_id_members_id_fk" FOREIGN KEY ("member_a_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_connections" ADD CONSTRAINT "member_connections_member_b_id_members_id_fk" FOREIGN KEY ("member_b_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_evaluations" ADD CONSTRAINT "pair_evaluations_member_a_id_members_id_fk" FOREIGN KEY ("member_a_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_evaluations" ADD CONSTRAINT "pair_evaluations_member_b_id_members_id_fk" FOREIGN KEY ("member_b_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_evaluations" ADD CONSTRAINT "pair_evaluations_portrait_version_a_id_portrait_versions_id_fk" FOREIGN KEY ("portrait_version_a_id") REFERENCES "public"."portrait_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_evaluations" ADD CONSTRAINT "pair_evaluations_portrait_version_b_id_portrait_versions_id_fk" FOREIGN KEY ("portrait_version_b_id") REFERENCES "public"."portrait_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_evaluations" ADD CONSTRAINT "pair_evaluations_criteria_version_a_id_match_criteria_versions_id_fk" FOREIGN KEY ("criteria_version_a_id") REFERENCES "public"."match_criteria_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pair_evaluations" ADD CONSTRAINT "pair_evaluations_criteria_version_b_id_match_criteria_versions_id_fk" FOREIGN KEY ("criteria_version_b_id") REFERENCES "public"."match_criteria_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_daily_runs" ADD CONSTRAINT "recommendation_daily_runs_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_recommendations_versions_unique" ON "candidate_recommendations" USING btree ("member_id","candidate_member_id","member_portrait_version_id","candidate_portrait_version_id","member_criteria_version_id","candidate_criteria_version_id");--> statement-breakpoint
CREATE INDEX "candidate_recommendations_member_status_index" ON "candidate_recommendations" USING btree ("member_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "matching_followup_member_evaluation_key_unique" ON "matching_followup_questions" USING btree ("member_id","pair_evaluation_id","question_key");--> statement-breakpoint
CREATE INDEX "matching_settings_audits_created_index" ON "matching_settings_audits" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "member_connections_status_index" ON "member_connections" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "pair_evaluations_versions_unique" ON "pair_evaluations" USING btree ("member_a_id","member_b_id","portrait_version_a_id","portrait_version_b_id","criteria_version_a_id","criteria_version_b_id","rubric_version");