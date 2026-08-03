CREATE TABLE IF NOT EXISTS "team_members" (
  "id" BIGSERIAL PRIMARY KEY,
  "team_id" integer not null REFERENCES "teams"("id"),
  "user_id" integer not null REFERENCES "users"("id"),
  "role" "team_members_role_type" default 'member',
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE INDEX IF NOT EXISTS "team_members_team_user_index" ON "team_members" ("team_id", "user_id");
