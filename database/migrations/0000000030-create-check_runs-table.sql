CREATE TABLE IF NOT EXISTS "check_runs" (
  "id" BIGSERIAL PRIMARY KEY,
  "repository_id" integer not null REFERENCES "repositories"("id"),
  "head_sha" varchar(40) not null,
  "name" varchar(255) not null,
  "status" "check_runs_status_type" default 'queued',
  "conclusion" "check_runs_conclusion_type",
  "details_url" text,
  "summary" text,
  "started_at" varchar(255),
  "completed_at" varchar(255),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE INDEX IF NOT EXISTS "check_runs_head_index" ON "check_runs" ("repository_id", "head_sha");
CREATE INDEX IF NOT EXISTS "check_runs_name_index" ON "check_runs" ("repository_id", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "check_runs_uuid_unique" ON "check_runs" ("uuid");
