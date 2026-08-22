ALTER TABLE "member_recommendation_restrictions" DROP CONSTRAINT "member_recommendation_restrictions_pkey";--> statement-breakpoint
ALTER TABLE "member_recommendation_restrictions" ADD CONSTRAINT "member_recommendation_restrictions_member_id_source_case_id_pk" PRIMARY KEY("member_id","source_case_id");
