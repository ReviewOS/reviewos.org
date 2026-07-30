CREATE TABLE IF NOT EXISTS "teams" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(100) not null,
  "description" text,
  "member_count" integer,
  "status" varchar(255),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "teams_teams_name_unique" ON "teams" ("name");
CREATE UNIQUE INDEX IF NOT EXISTS "teams_teams_uuid_unique" ON "teams" ("uuid");
