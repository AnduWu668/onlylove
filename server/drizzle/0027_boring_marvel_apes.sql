CREATE TABLE "member_deletion_audits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_member_id" uuid NOT NULL,
	"target_member_id" uuid NOT NULL,
	"action" varchar(16) NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "member_deletion_audits" ADD CONSTRAINT "member_deletion_audits_actor_member_id_members_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_deletion_audits" ADD CONSTRAINT "member_deletion_audits_target_member_id_members_id_fk" FOREIGN KEY ("target_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_deletion_audits_created_index" ON "member_deletion_audits" USING btree ("created_at");