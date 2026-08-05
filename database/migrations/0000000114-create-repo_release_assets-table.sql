CREATE TABLE IF NOT EXISTS "repo_release_assets" (
  "id" BIGSERIAL PRIMARY KEY,
  "repo_release_id" integer not null REFERENCES "repo_releases"("id"),
  "name" varchar(255) not null,
  "storage_path" text not null,
  "content_type" varchar(160) default 'application/octet-stream',
  "size_bytes" integer default 0,
  "checksum" varchar(64),
  "download_count" integer default 0,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS "repo_release_assets_release_name_index" ON "repo_release_assets" ("repo_release_id", "name");
