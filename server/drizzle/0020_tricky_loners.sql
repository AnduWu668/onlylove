CREATE TABLE "contact_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recommendation_id" uuid NOT NULL,
	"requester_member_id" uuid NOT NULL,
	"recipient_member_id" uuid NOT NULL,
	"status" varchar(16) NOT NULL,
	"connection_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "current_connection_members" (
	"member_id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "contact_request_id" uuid;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "suspended_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contact_requests" ADD CONSTRAINT "contact_requests_recommendation_id_candidate_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."candidate_recommendations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_requests" ADD CONSTRAINT "contact_requests_requester_member_id_members_id_fk" FOREIGN KEY ("requester_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_requests" ADD CONSTRAINT "contact_requests_recipient_member_id_members_id_fk" FOREIGN KEY ("recipient_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_requests" ADD CONSTRAINT "contact_requests_connection_id_member_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."member_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "current_connection_members" ADD CONSTRAINT "current_connection_members_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "current_connection_members" ADD CONSTRAINT "current_connection_members_connection_id_member_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."member_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_requests_recommendation_unique" ON "contact_requests" USING btree ("recommendation_id");--> statement-breakpoint
CREATE INDEX "contact_requests_recipient_status_index" ON "contact_requests" USING btree ("recipient_member_id","status");--> statement-breakpoint
CREATE INDEX "contact_requests_requester_status_index" ON "contact_requests" USING btree ("requester_member_id","status");--> statement-breakpoint
CREATE INDEX "current_connection_members_connection_index" ON "current_connection_members" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_visitor_contact_request_unique" ON "conversations" USING btree ("visitor_member_id","contact_request_id") WHERE "conversations"."contact_request_id" is not null;