CREATE TABLE "distortion_feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reporter_member_id" uuid NOT NULL,
	"twin_owner_member_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"details" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_recommendation_restrictions" (
	"member_id" uuid PRIMARY KEY NOT NULL,
	"source_case_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" varchar(16) NOT NULL,
	"reporter_member_id" uuid NOT NULL,
	"reported_member_id" uuid NOT NULL,
	"target_kind" varchar(24) NOT NULL,
	"target_id" uuid NOT NULL,
	"message_id" uuid,
	"conversation_id" uuid,
	"reason" text NOT NULL,
	"evidence" text NOT NULL,
	"status" varchar(16) NOT NULL,
	"original_case_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "moderation_decisions" (
	"case_id" uuid PRIMARY KEY NOT NULL,
	"decided_by_member_id" uuid NOT NULL,
	"action" varchar(16) NOT NULL,
	"reason" text NOT NULL,
	"suspended_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_notification_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"recipient_member_id" uuid NOT NULL,
	"email" varchar(320) NOT NULL,
	"disclosure" varchar(16) NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "distortion_feedback" ADD CONSTRAINT "distortion_feedback_reporter_member_id_members_id_fk" FOREIGN KEY ("reporter_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distortion_feedback" ADD CONSTRAINT "distortion_feedback_twin_owner_member_id_members_id_fk" FOREIGN KEY ("twin_owner_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distortion_feedback" ADD CONSTRAINT "distortion_feedback_message_id_conversation_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_recommendation_restrictions" ADD CONSTRAINT "member_recommendation_restrictions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_recommendation_restrictions" ADD CONSTRAINT "member_recommendation_restrictions_source_case_id_moderation_cases_id_fk" FOREIGN KEY ("source_case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_reporter_member_id_members_id_fk" FOREIGN KEY ("reporter_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_reported_member_id_members_id_fk" FOREIGN KEY ("reported_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_cases" ADD CONSTRAINT "moderation_cases_message_id_conversation_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_decisions" ADD CONSTRAINT "moderation_decisions_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_decisions" ADD CONSTRAINT "moderation_decisions_decided_by_member_id_members_id_fk" FOREIGN KEY ("decided_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_notification_outbox" ADD CONSTRAINT "moderation_notification_outbox_case_id_moderation_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."moderation_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_notification_outbox" ADD CONSTRAINT "moderation_notification_outbox_recipient_member_id_members_id_fk" FOREIGN KEY ("recipient_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "distortion_feedback_reporter_message_unique" ON "distortion_feedback" USING btree ("reporter_member_id","message_id");--> statement-breakpoint
CREATE INDEX "distortion_feedback_owner_index" ON "distortion_feedback" USING btree ("twin_owner_member_id");--> statement-breakpoint
CREATE INDEX "moderation_cases_status_index" ON "moderation_cases" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "moderation_cases_reporter_index" ON "moderation_cases" USING btree ("reporter_member_id");--> statement-breakpoint
CREATE INDEX "moderation_cases_reported_index" ON "moderation_cases" USING btree ("reported_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_cases_original_case_unique" ON "moderation_cases" USING btree ("original_case_id") WHERE "moderation_cases"."original_case_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_notification_case_disclosure_unique" ON "moderation_notification_outbox" USING btree ("case_id","disclosure");--> statement-breakpoint
CREATE INDEX "moderation_notification_unsent_index" ON "moderation_notification_outbox" USING btree ("sent_at");