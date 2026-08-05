CREATE TABLE IF NOT EXISTS "attachments" (
  "id" BIGSERIAL PRIMARY KEY,
  "key" varchar(64) not null,
  "repository_id" integer not null REFERENCES "repositories"("id"),
  "uploader_id" integer REFERENCES "users"("id"),
  "filename" varchar(255) not null,
  "content_type" varchar(100) not null,
  "byte_size" integer not null,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "attachments_key_index" ON "attachments" ("key");
CREATE INDEX IF NOT EXISTS "attachments_repository_index" ON "attachments" ("repository_id");
CREATE UNIQUE INDEX IF NOT EXISTS "attachments_key_unique" ON "attachments" ("key");
CREATE UNIQUE INDEX IF NOT EXISTS "attachments_uuid_unique" ON "attachments" ("uuid");
