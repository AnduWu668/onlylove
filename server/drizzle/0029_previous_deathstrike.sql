CREATE TABLE "administration_audits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_member_id" uuid NOT NULL,
	"target_member_id" uuid,
	"action" varchar(48) NOT NULL,
	"resource_id" uuid,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "administration_audits" ADD CONSTRAINT "administration_audits_actor_member_id_members_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "administration_audits" ADD CONSTRAINT "administration_audits_target_member_id_members_id_fk" FOREIGN KEY ("target_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "administration_audits_created_index" ON "administration_audits" USING btree ("created_at");