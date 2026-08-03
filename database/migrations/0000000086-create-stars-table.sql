CREATE TABLE IF NOT EXISTS "stars" (
  "id" BIGSERIAL PRIMARY KEY,
  "repository_id" integer not null REFERENCES "repositories"("id"),
  "user_id" integer not null REFERENCES "users"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE INDEX IF NOT EXISTS "stars_repo_user_index" ON "stars" ("repository_id", "user_id");
