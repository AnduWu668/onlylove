CREATE TABLE "recommendation_pair_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"candidate_member_id" uuid NOT NULL,
	"run_date" date,
	"recommendation_id" uuid,
	"agent_job_id" uuid,
	"pair_evaluation_id" uuid,
	"member_portrait_version_id" uuid NOT NULL,
	"candidate_portrait_version_id" uuid NOT NULL,
	"member_criteria_version_id" uuid NOT NULL,
	"candidate_criteria_version_id" uuid NOT NULL,
	"input" jsonb NOT NULL,
	"status" varchar(16) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pair_evaluations" ADD COLUMN "agent_job_id" uuid;--> statement-breakpoint
ALTER TABLE "recommendation_pair_jobs" ADD CONSTRAINT "recommendation_pair_jobs_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_pair_jobs" ADD CONSTRAINT "recommendation_pair_jobs_candidate_member_id_members_id_fk" FOREIGN KEY ("candidate_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_pair_jobs" ADD CONSTRAINT "recommendation_pair_jobs_recommendation_id_candidate_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."candidate_recommendations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_pair_jobs" ADD CONSTRAINT "recommendation_pair_jobs_agent_job_id_agent_jobs_id_fk" FOREIGN KEY ("agent_job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_pair_jobs" ADD CONSTRAINT "recommendation_pair_jobs_pair_evaluation_id_pair_evaluations_id_fk" FOREIGN KEY ("pair_evaluation_id") REFERENCES "public"."pair_evaluations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_pair_jobs" ADD CONSTRAINT "recommendation_pair_jobs_member_portrait_version_id_portrait_versions_id_fk" FOREIGN KEY ("member_portrait_version_id") REFERENCES "public"."portrait_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_pair_jobs" ADD CONSTRAINT "recommendation_pair_jobs_candidate_portrait_version_id_portrait_versions_id_fk" FOREIGN KEY ("candidate_portrait_version_id") REFERENCES "public"."portrait_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_pair_jobs" ADD CONSTRAINT "recommendation_pair_jobs_member_criteria_version_id_match_criteria_versions_id_fk" FOREIGN KEY ("member_criteria_version_id") REFERENCES "public"."match_criteria_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_pair_jobs" ADD CONSTRAINT "recommendation_pair_jobs_candidate_criteria_version_id_match_criteria_versions_id_fk" FOREIGN KEY ("candidate_criteria_version_id") REFERENCES "public"."match_criteria_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recommendation_pair_jobs_agent_job_unique" ON "recommendation_pair_jobs" USING btree ("agent_job_id");--> statement-breakpoint
CREATE INDEX "recommendation_pair_jobs_run_index" ON "recommendation_pair_jobs" USING btree ("member_id","run_date","status");--> statement-breakpoint
CREATE INDEX "recommendation_pair_jobs_recommendation_index" ON "recommendation_pair_jobs" USING btree ("recommendation_id","status");--> statement-breakpoint
ALTER TABLE "pair_evaluations" ADD CONSTRAINT "pair_evaluations_agent_job_id_agent_jobs_id_fk" FOREIGN KEY ("agent_job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pair_evaluations_agent_job_unique" ON "pair_evaluations" USING btree ("agent_job_id");