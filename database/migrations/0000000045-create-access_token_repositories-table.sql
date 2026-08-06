CREATE TABLE IF NOT EXISTS "access_token_repositories" (
  "id" BIGSERIAL PRIMARY KEY,
  "access_token_id" bigint not null REFERENCES "access_tokens"("id"),
  "repository_id" bigint not null REFERENCES "repositories"("id") ON DELETE CASCADE,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE INDEX IF NOT EXISTS "access_token_repositories_token_index" ON "access_token_repositories" ("access_token_id");
CREATE INDEX IF NOT EXISTS "access_token_repositories_repository_index" ON "access_token_repositories" ("repository_id");
