CREATE TABLE "agent_quota_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"own_agent_daily_limit" integer NOT NULL,
	"candidate_twin_daily_limit" integer NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_quota_settings_audits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" uuid NOT NULL,
	"previous_own_agent_daily_limit" integer NOT NULL,
	"previous_candidate_twin_daily_limit" integer NOT NULL,
	"own_agent_daily_limit" integer NOT NULL,
	"candidate_twin_daily_limit" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_quota_settings" ADD CONSTRAINT "agent_quota_settings_updated_by_members_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_quota_settings_audits" ADD CONSTRAINT "agent_quota_settings_audits_actor_id_members_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_quota_settings_audits_created_index" ON "agent_quota_settings_audits" USING btree ("created_at");