CREATE TABLE IF NOT EXISTS "stars" (
  "id" BIGSERIAL PRIMARY KEY,
  "repository_id" bigint not null REFERENCES "repositories"("id") ON DELETE CASCADE,
  "user_id" bigint not null REFERENCES "users"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS "stars_repo_user_index" ON "stars" ("repository_id", "user_id");
