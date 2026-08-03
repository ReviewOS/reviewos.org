CREATE TABLE IF NOT EXISTS "releases" (
  "id" BIGSERIAL PRIMARY KEY,
  "version" varchar(50) not null,
  "type" varchar(255) not null,
  "status" varchar(255) not null,
  "notes" varchar(255),
  "downloads" integer,
  "author" varchar(255),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "releases_uuid_unique" ON "releases" ("uuid");
