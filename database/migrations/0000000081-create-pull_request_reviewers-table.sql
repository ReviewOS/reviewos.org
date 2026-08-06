CREATE TABLE IF NOT EXISTS "pull_request_reviewers" (
  "id" BIGSERIAL PRIMARY KEY,
  "pull_request_id" bigint not null REFERENCES "pull_requests"("id"),
  "reviewer_type" "pull_request_reviewers_reviewer_type_type" default 'user',
  "reviewer_id" integer not null,
  "requested_by_id" bigint REFERENCES "users"("id") ON DELETE SET NULL,
  "from_code_owners" boolean default false,
  "responded_at" varchar(255),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE INDEX IF NOT EXISTS "pull_request_reviewers_pr_reviewers_pr_index" ON "pull_request_reviewers" ("pull_request_id");
