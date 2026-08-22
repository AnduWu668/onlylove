CREATE TABLE "connection_followup_responses" (
	"connection_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"decision" varchar(16) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connection_followup_responses_connection_id_member_id_pk" PRIMARY KEY("connection_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "connection_recoveries" (
	"connection_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"reviewed_at" timestamp with time zone,
	"resumed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connection_recoveries_connection_id_member_id_pk" PRIMARY KEY("connection_id","member_id")
);
--> statement-breakpoint
ALTER TABLE "contact_notification_outbox" ALTER COLUMN "contact_request_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_notification_outbox" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "member_connections" ADD COLUMN "mutual_continue_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "member_connections" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connection_followup_responses" ADD CONSTRAINT "connection_followup_responses_connection_id_member_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."member_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_followup_responses" ADD CONSTRAINT "connection_followup_responses_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_recoveries" ADD CONSTRAINT "connection_recoveries_connection_id_member_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."member_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_recoveries" ADD CONSTRAINT "connection_recoveries_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_followup_member_index" ON "connection_followup_responses" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "connection_recoveries_member_index" ON "connection_recoveries" USING btree ("member_id","resumed_at");--> statement-breakpoint
ALTER TABLE "contact_notification_outbox" ADD CONSTRAINT "contact_notification_outbox_connection_id_member_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."member_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_notification_outbox_connection_event_unique" ON "contact_notification_outbox" USING btree ("connection_id","type","email");