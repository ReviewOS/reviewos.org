CREATE TABLE IF NOT EXISTS "teams" (
  "id" BIGSERIAL PRIMARY KEY,
  "organization_id" integer not null REFERENCES "organizations"("id"),
  "name" varchar(100) not null,
  "slug" varchar(100) not null,
  "description" text,
  "parent_team_id" integer,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE INDEX IF NOT EXISTS "teams_teams_org_slug_index" ON "teams" ("organization_id", "slug");
CREATE UNIQUE INDEX IF NOT EXISTS "teams_teams_uuid_unique" ON "teams" ("uuid");
