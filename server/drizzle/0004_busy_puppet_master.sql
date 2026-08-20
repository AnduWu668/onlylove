ALTER TABLE "agent_jobs" ADD COLUMN "output_message_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_output_message_id_conversation_messages_id_fk" FOREIGN KEY ("output_message_id") REFERENCES "public"."conversation_messages"("id") ON DELETE no action ON UPDATE no action;