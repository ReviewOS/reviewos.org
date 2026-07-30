CREATE TABLE IF NOT EXISTS "repo_collaborators" (
  "id" BIGSERIAL PRIMARY KEY,
  "repository_id" integer not null REFERENCES "repositories"("id"),
  "user_id" integer not null REFERENCES "users"("id"),
  "permission" "repo_collaborators_permission_type" default 'read',
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE INDEX IF NOT EXISTS "repo_collaborators_repo_collaborators_repo_user_index" ON "repo_collaborators" ("repository_id", "user_id");
