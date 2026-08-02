CREATE INDEX IF NOT EXISTS "repository_mirrors_due_index" ON "repository_mirrors" ("enabled", "last_synced_at");
