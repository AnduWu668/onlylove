ALTER TABLE "agent_jobs" ADD COLUMN "definition_version" varchar(80) NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "prompt_version" varchar(80) NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "schema_version" varchar(80);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "definition_version" varchar(80) NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "prompt_version" varchar(80) NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "schema_version" varchar(80);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "input_cost_cny_per_million_tokens" double precision;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "output_cost_cny_per_million_tokens" double precision;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "pricing_effective_date" date;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_job_retry_unique" ON "agent_runs" USING btree ("job_id","retry_count");
