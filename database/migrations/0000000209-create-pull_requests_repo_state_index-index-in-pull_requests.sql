CREATE INDEX IF NOT EXISTS "pull_requests_repo_state_index" ON "pull_requests" ("repository_id", "state");
