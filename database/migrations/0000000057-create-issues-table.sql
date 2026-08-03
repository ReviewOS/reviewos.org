CREATE TABLE IF NOT EXISTS "issues" (
  "id" BIGSERIAL PRIMARY KEY,
  "repository_id" integer not null REFERENCES "repositories"("id"),
  "number" integer not null,
  "title" varchar(255) not null,
  "body" text,
  "author_id" integer REFERENCES "users"("id"),
  "state" "issues_state_type" default 'open',
  "state_reason" "issues_state_reason_type",
  "closed_at" varchar(255),
  "closed_by_id" integer,
  "milestone_id" integer,
  "locked" boolean default false,
  "comments_count" integer default 0,
  "is_pull_request" boolean default false,
  "external_author" varchar(120),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE INDEX IF NOT EXISTS "issues_repo_number_index" ON "issues" ("repository_id", "number");
CREATE INDEX IF NOT EXISTS "issues_repo_state_index" ON "issues" ("repository_id", "state");
CREATE UNIQUE INDEX IF NOT EXISTS "issues_uuid_unique" ON "issues" ("uuid");
