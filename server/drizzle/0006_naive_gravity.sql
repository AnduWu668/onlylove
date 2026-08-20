CREATE TABLE "portrait_drafts" (
	"member_id" uuid PRIMARY KEY NOT NULL,
	"schema_version" varchar(80) NOT NULL,
	"planner_version" varchar(80) NOT NULL,
	"content" jsonb NOT NULL,
	"completed_dimensions" integer NOT NULL,
	"last_message_sequence" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portrait_fixed_answers" (
	"member_id" uuid NOT NULL,
	"question_id" varchar(80) NOT NULL,
	"selected_option_ids" varchar(80)[] NOT NULL,
	"none_applies" boolean NOT NULL,
	"free_text" text NOT NULL,
	"message_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portrait_fixed_answers_member_id_question_id_pk" PRIMARY KEY("member_id","question_id")
);
--> statement-breakpoint
DROP INDEX "agent_runs_job_retry_unique";--> statement-breakpoint
ALTER TABLE "portrait_drafts" ADD CONSTRAINT "portrait_drafts_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portrait_fixed_answers" ADD CONSTRAINT "portrait_fixed_answers_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portrait_fixed_answers" ADD CONSTRAINT "portrait_fixed_answers_message_id_conversation_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portrait_fixed_answers_member_index" ON "portrait_fixed_answers" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_job_task_retry_unique" ON "agent_runs" USING btree ("job_id","task","retry_count");