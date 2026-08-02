CREATE INDEX IF NOT EXISTS "repositories_owner_name_index" ON "repositories" ("owner_type", "owner_id", "name");
