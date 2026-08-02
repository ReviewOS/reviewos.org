ALTER TABLE "issue_comments" ALTER COLUMN "author_id" DROP DEFAULT;
ALTER TABLE "issue_comments" ALTER COLUMN "author_id" TYPE integer USING "author_id"::integer;
ALTER TABLE "issue_comments" ALTER COLUMN "author_id" DROP NOT NULL;
ALTER TABLE "pull_request_reviews" ALTER COLUMN "reviewer_id" DROP DEFAULT;
ALTER TABLE "pull_request_reviews" ALTER COLUMN "reviewer_id" TYPE integer USING "reviewer_id"::integer;
ALTER TABLE "pull_request_reviews" ALTER COLUMN "reviewer_id" DROP NOT NULL;
