CREATE TABLE IF NOT EXISTS "release_assets" (
  "id" BIGSERIAL PRIMARY KEY,
  "release_id" integer not null REFERENCES "releases"("id"),
  "name" varchar(255) not null,
  "storage_path" text not null,
  "content_type" varchar(160) default 'application/octet-stream',
  "size_bytes" integer default 0,
  "checksum" varchar(64),
  "download_count" integer default 0,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS "release_assets_release_name_index" ON "release_assets" ("release_id", "name");
