CREATE TABLE "candidate_twin_daily_quotas" (
	"member_id" uuid NOT NULL,
	"quota_date" date NOT NULL,
	"used" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "candidate_twin_daily_quotas_member_id_quota_date_pk" PRIMARY KEY("member_id","quota_date")
);
--> statement-breakpoint
DROP INDEX "conversations_member_type_unique";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "visitor_member_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "recommendation_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "anonymous_code" varchar(16);--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "visibility_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "candidate_twin_daily_quotas" ADD CONSTRAINT "candidate_twin_daily_quotas_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_visitor_member_id_members_id_fk" FOREIGN KEY ("visitor_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_visitor_recommendation_unique" ON "conversations" USING btree ("visitor_member_id","recommendation_id") WHERE "conversations"."visitor_member_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_anonymous_code_unique" ON "conversations" USING btree ("anonymous_code");--> statement-breakpoint
CREATE INDEX "conversations_owner_visitor_index" ON "conversations" USING btree ("member_id","visitor_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_member_type_unique" ON "conversations" USING btree ("member_id","type") WHERE "conversations"."visitor_member_id" is null;