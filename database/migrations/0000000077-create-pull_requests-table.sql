CREATE TABLE IF NOT EXISTS "pull_requests" (
  "id" BIGSERIAL PRIMARY KEY,
  "repository_id" integer not null REFERENCES "repositories"("id"),
  "number" integer not null,
  "title" varchar(255) not null,
  "body" text,
  "author_id" integer REFERENCES "users"("id"),
  "state" "pull_requests_state_type" default 'open',
  "head_repository_id" integer,
  "head_branch" varchar(255) not null,
  "head_sha" varchar(40),
  "base_branch" varchar(255) not null default 'main',
  "base_sha" varchar(40),
  "merge_commit_sha" varchar(40),
  "merged_at" varchar(255),
  "merged_by_id" integer,
  "draft" boolean default false,
  "mergeable_state" "pull_requests_mergeable_state_type" default 'unknown',
  "stack_parent_id" integer,
  "additions" integer default 0,
  "deletions" integer default 0,
  "changed_files" integer default 0,
  "closed_at" varchar(255),
  "closed_by_id" integer,
  "mergeable_base_sha" varchar(40),
  "mergeable_head_sha" varchar(40),
  "mergeable_conflicts" text,
  "external_author" varchar(120),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE INDEX IF NOT EXISTS "pull_requests_repo_number_index" ON "pull_requests" ("repository_id", "number");
CREATE INDEX IF NOT EXISTS "pull_requests_repo_state_index" ON "pull_requests" ("repository_id", "state");
CREATE INDEX IF NOT EXISTS "pull_requests_stack_index" ON "pull_requests" ("stack_parent_id");
CREATE UNIQUE INDEX IF NOT EXISTS "pull_requests_uuid_unique" ON "pull_requests" ("uuid");
