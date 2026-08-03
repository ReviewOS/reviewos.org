CREATE TABLE IF NOT EXISTS "watches" (
  "id" BIGSERIAL PRIMARY KEY,
  "repository_id" integer not null REFERENCES "repositories"("id"),
  "user_id" integer not null REFERENCES "users"("id"),
  "subscription" "watches_subscription_type" default 'participating',
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE INDEX IF NOT EXISTS "watches_repo_user_index" ON "watches" ("repository_id", "user_id");
