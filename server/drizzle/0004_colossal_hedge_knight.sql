ALTER TABLE "members" ADD COLUMN "password_hash" varchar(256);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "password_setup_required" boolean DEFAULT false NOT NULL;