ALTER TABLE "issues" ALTER COLUMN "author_id" TYPE integer USING "author_id"::integer;
ALTER TABLE "issues" ALTER COLUMN "author_id" DROP NOT NULL;
ALTER TABLE "issues" ALTER COLUMN "author_id" DROP DEFAULT;
ALTER TABLE "pull_requests" ALTER COLUMN "author_id" TYPE integer USING "author_id"::integer;
ALTER TABLE "pull_requests" ALTER COLUMN "author_id" DROP NOT NULL;
ALTER TABLE "pull_requests" ALTER COLUMN "author_id" DROP DEFAULT;
ALTER TABLE "review_comments" ALTER COLUMN "author_id" TYPE integer USING "author_id"::integer;
ALTER TABLE "review_comments" ALTER COLUMN "author_id" DROP NOT NULL;
ALTER TABLE "review_comments" ALTER COLUMN "author_id" DROP DEFAULT;
