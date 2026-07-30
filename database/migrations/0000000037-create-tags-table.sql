CREATE TABLE IF NOT EXISTS "tags" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(50) not null,
  "slug" varchar(50) not null,
  "description" varchar(255),
  "color" varchar(20),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "tags_tags_name_unique" ON "tags" ("name");
CREATE UNIQUE INDEX IF NOT EXISTS "tags_tags_slug_unique" ON "tags" ("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "tags_tags_uuid_unique" ON "tags" ("uuid");
