CREATE TABLE "agent_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role" varchar(40) NOT NULL,
	"task" varchar(40) NOT NULL,
	"member_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"input_message_id" uuid NOT NULL,
	"status" varchar(16) NOT NULL,
	"retry_count" integer NOT NULL,
	"switched_model" boolean NOT NULL,
	"quota_refunded" boolean NOT NULL,
	"error" varchar(80),
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"role" varchar(40) NOT NULL,
	"task" varchar(40) NOT NULL,
	"member_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"provider" varchar(80) NOT NULL,
	"requested_model" varchar(160) NOT NULL,
	"actual_model" varchar(160) NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"retry_count" integer NOT NULL,
	"switched_model" boolean NOT NULL,
	"error" varchar(80),
	"estimated_cost_micro_cny" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"content" text NOT NULL,
	"sequence" integer NOT NULL,
	"client_message_id" uuid,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" varchar(16) NOT NULL,
	"member_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "own_agent_daily_quotas" (
	"member_id" uuid NOT NULL,
	"quota_date" date NOT NULL,
	"used" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "own_agent_daily_quotas_member_id_quota_date_pk" PRIMARY KEY("member_id","quota_date")
);
--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_input_message_id_conversation_messages_id_fk" FOREIGN KEY ("input_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_job_id_agent_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."agent_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "own_agent_daily_quotas" ADD CONSTRAINT "own_agent_daily_quotas_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_jobs_member_index" ON "agent_jobs" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "agent_jobs_status_index" ON "agent_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agent_runs_job_index" ON "agent_runs" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_messages_sequence_unique" ON "conversation_messages" USING btree ("conversation_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_messages_client_id_unique" ON "conversation_messages" USING btree ("conversation_id","client_message_id");--> statement-breakpoint
CREATE INDEX "conversation_messages_conversation_index" ON "conversation_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_member_type_unique" ON "conversations" USING btree ("member_id","type");