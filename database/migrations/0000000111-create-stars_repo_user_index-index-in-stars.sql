CREATE UNIQUE INDEX IF NOT EXISTS "stars_repo_user_index" ON "stars" ("repository_id", "user_id");
