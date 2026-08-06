CREATE TABLE IF NOT EXISTS "watches" (
  "id" BIGSERIAL PRIMARY KEY,
  "repository_id" bigint not null REFERENCES "repositories"("id") ON DELETE CASCADE,
  "user_id" bigint not null REFERENCES "users"("id"),
  "subscription" "watches_subscription_type" default 'participating',
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS "watches_repo_user_index" ON "watches" ("repository_id", "user_id");
