ALTER TABLE "review_comments" DROP CONSTRAINT IF EXISTS "review_comments_review_id_fk";
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_review_id_fk" FOREIGN KEY ("review_id") REFERENCES "pull_request_reviews"("id");
ALTER TABLE "review_comments" DROP CONSTRAINT IF EXISTS "review_comments_author_id_fk";
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_author_id_fk" FOREIGN KEY ("author_id") REFERENCES "users"("id");
ALTER TABLE "review_comments" ADD COLUMN IF NOT EXISTS "external_id" integer;
ALTER TABLE "review_comments" ADD COLUMN IF NOT EXISTS "external_author" varchar(120);
