CREATE TABLE "contact_notification_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"contact_request_id" uuid NOT NULL,
	"type" varchar(24) NOT NULL,
	"email" varchar(320) NOT NULL,
	"nickname" varchar(120) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "contact_notification_outbox" ADD CONSTRAINT "contact_notification_outbox_contact_request_id_contact_requests_id_fk" FOREIGN KEY ("contact_request_id") REFERENCES "public"."contact_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_notification_outbox_event_unique" ON "contact_notification_outbox" USING btree ("contact_request_id","type","email");--> statement-breakpoint
CREATE INDEX "contact_notification_outbox_sent_index" ON "contact_notification_outbox" USING btree ("sent_at");