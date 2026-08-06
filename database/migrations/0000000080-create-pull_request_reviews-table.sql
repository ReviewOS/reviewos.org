CREATE TABLE IF NOT EXISTS "pull_request_reviews" (
  "id" BIGSERIAL PRIMARY KEY,
  "pull_request_id" bigint not null REFERENCES "pull_requests"("id"),
  "reviewer_id" bigint REFERENCES "users"("id"),
  "state" "pull_request_reviews_state_type" default 'pending',
  "body" text,
  "commit_sha" varchar(40),
  "submitted_at" varchar(255),
  "dismissed_reason" text,
  "external_author" varchar(120),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE INDEX IF NOT EXISTS "pull_request_reviews_pr_reviews_pr_index" ON "pull_request_reviews" ("pull_request_id");
CREATE INDEX IF NOT EXISTS "pull_request_reviews_pr_reviews_reviewer_index" ON "pull_request_reviews" ("pull_request_id", "reviewer_id");
