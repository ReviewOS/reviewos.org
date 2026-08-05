CREATE UNIQUE INDEX IF NOT EXISTS "releases_repo_tag_index" ON "releases" ("repository_id", "tag_name");
