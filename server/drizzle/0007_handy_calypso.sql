CREATE TABLE "portrait_calibration_scenarios" (
	"id" uuid PRIMARY KEY NOT NULL,
	"portrait_version_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"dimensions" varchar(40)[] NOT NULL,
	"prompt" text NOT NULL,
	"prediction" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portrait_member_states" (
	"member_id" uuid PRIMARY KEY NOT NULL,
	"submitted_version_id" uuid NOT NULL,
	"published_version_id" uuid,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portrait_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"client_request_id" uuid NOT NULL,
	"source_draft_schema_version" varchar(80) NOT NULL,
	"match_profile" jsonb NOT NULL,
	"persona_context_schema_version" varchar(80) NOT NULL,
	"persona_context" text NOT NULL,
	"calibration_schema_version" varchar(80) NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portrait_calibration_scenarios" ADD CONSTRAINT "portrait_calibration_scenarios_portrait_version_id_portrait_versions_id_fk" FOREIGN KEY ("portrait_version_id") REFERENCES "public"."portrait_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portrait_member_states" ADD CONSTRAINT "portrait_member_states_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portrait_member_states" ADD CONSTRAINT "portrait_member_states_submitted_version_id_portrait_versions_id_fk" FOREIGN KEY ("submitted_version_id") REFERENCES "public"."portrait_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portrait_member_states" ADD CONSTRAINT "portrait_member_states_published_version_id_portrait_versions_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "public"."portrait_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portrait_versions" ADD CONSTRAINT "portrait_versions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portrait_calibration_version_position_unique" ON "portrait_calibration_scenarios" USING btree ("portrait_version_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "portrait_versions_member_version_unique" ON "portrait_versions" USING btree ("member_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "portrait_versions_member_request_unique" ON "portrait_versions" USING btree ("member_id","client_request_id");