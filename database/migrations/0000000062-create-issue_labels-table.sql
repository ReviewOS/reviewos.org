CREATE TABLE IF NOT EXISTS "issue_labels" (
  "id" BIGSERIAL PRIMARY KEY,
  "issue_id" bigint not null REFERENCES "issues"("id"),
  "label_id" bigint not null REFERENCES "repository_labels"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE INDEX IF NOT EXISTS "issue_labels_issue_index" ON "issue_labels" ("issue_id", "label_id");
