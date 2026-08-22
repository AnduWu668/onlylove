ALTER TABLE "conversation_messages" ADD COLUMN "sender_member_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "member_last_read_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "visitor_last_read_sequence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_sender_member_id_members_id_fk" FOREIGN KEY ("sender_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_connection_id_member_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."member_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_connection_unique" ON "conversations" USING btree ("connection_id") WHERE "conversations"."connection_id" is not null;