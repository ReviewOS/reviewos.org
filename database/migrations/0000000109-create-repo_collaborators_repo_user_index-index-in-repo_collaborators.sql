CREATE UNIQUE INDEX IF NOT EXISTS "repo_collaborators_repo_user_index" ON "repo_collaborators" ("repository_id", "user_id");
