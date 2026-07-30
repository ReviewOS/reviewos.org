CREATE TABLE IF NOT EXISTS "issue_assignees" (
  "id" BIGSERIAL PRIMARY KEY,
  "issue_id" integer not null REFERENCES "issues"("id"),
  "user_id" integer not null REFERENCES "users"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE INDEX IF NOT EXISTS "issue_assignees_issue_assignees_issue_index" ON "issue_assignees" ("issue_id", "user_id");
