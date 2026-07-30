CREATE TABLE IF NOT EXISTS "boards" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(120) not null,
  "description" text,
  "icon" varchar(80),
  "color" varchar(40),
  "position" integer,
  "archived" boolean,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "boards_boards_uuid_unique" ON "boards" ("uuid");
