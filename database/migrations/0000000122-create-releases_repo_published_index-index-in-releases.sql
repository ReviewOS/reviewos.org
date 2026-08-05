CREATE INDEX IF NOT EXISTS "releases_repo_published_index" ON "releases" ("repository_id", "published_at");
