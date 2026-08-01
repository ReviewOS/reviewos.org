ALTER TABLE "pull_request_reviews" DROP CONSTRAINT IF EXISTS "pull_request_reviews_reviewer_id_fk";
ALTER TABLE "pull_request_reviews" ADD CONSTRAINT "pull_request_reviews_reviewer_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id");
