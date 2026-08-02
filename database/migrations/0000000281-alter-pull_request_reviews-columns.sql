ALTER TABLE "pull_request_reviews" ADD COLUMN IF NOT EXISTS "external_author" varchar(120);
