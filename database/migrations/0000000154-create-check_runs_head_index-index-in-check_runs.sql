CREATE INDEX IF NOT EXISTS "check_runs_head_index" ON "check_runs" ("repository_id", "head_sha");
