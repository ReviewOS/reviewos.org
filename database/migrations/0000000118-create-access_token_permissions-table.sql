CREATE TABLE IF NOT EXISTS "access_token_permissions" (
  "id" BIGSERIAL PRIMARY KEY,
  "access_token_id" integer not null REFERENCES "access_tokens"("id"),
  "scope" "access_token_permissions_scope_type",
  "level" "access_token_permissions_level_type" default 'read',
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE INDEX IF NOT EXISTS "access_token_permissions_token_index" ON "access_token_permissions" ("access_token_id");
