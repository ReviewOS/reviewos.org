CREATE TABLE IF NOT EXISTS "milestones" (
  "id" BIGSERIAL PRIMARY KEY,
  "repository_id" integer not null REFERENCES "repositories"("id"),
  "title" varchar(255) not null,
  "description" text,
  "due_on" varchar(255),
  "state" "milestones_state_type" default 'open',
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE INDEX IF NOT EXISTS "milestones_repo_index" ON "milestones" ("repository_id");
