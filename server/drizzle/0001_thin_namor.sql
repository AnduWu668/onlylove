CREATE TABLE "match_criteria_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"desired_gender" varchar(16) NOT NULL,
	"age_minimum" integer,
	"age_maximum" integer,
	"age_mode" varchar(16),
	"height_minimum_cm" integer,
	"height_maximum_cm" integer,
	"height_mode" varchar(16),
	"acceptable_cities" varchar(60)[] NOT NULL,
	"occupation_requirement" varchar(100),
	"occupation_mode" varchar(16),
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "nickname" varchar(40);--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "gender" varchar(16);--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "height_cm" integer;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "city" varchar(60);--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "occupation" varchar(80);--> statement-breakpoint
ALTER TABLE "match_criteria_versions" ADD CONSTRAINT "match_criteria_versions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "match_criteria_member_version_unique" ON "match_criteria_versions" USING btree ("member_id","version");