CREATE TABLE IF NOT EXISTS "repository_mirrors" (
  "id" BIGSERIAL PRIMARY KEY,
  "repository_id" bigint not null REFERENCES "repositories"("id") ON DELETE CASCADE,
  "direction" "repository_mirrors_direction_type" default 'pull',
  "provider" "repository_mirrors_provider_type" default 'github',
  "remote_url" varchar(500) not null,
  "remote_owner" varchar(120),
  "remote_name" varchar(120),
  "credential_ref" varchar(200),
  "interval_seconds" integer default 900,
  "enabled" boolean default true,
  "last_synced_at" varchar(255),
  "last_sha" varchar(64),
  "last_error" text,
  "failure_count" integer default 0,
  "sync_metadata" boolean default false,
  "last_metadata_sync_at" varchar(255),
  "metadata_error" text,
  "metadata_failure_count" integer default 0,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE INDEX IF NOT EXISTS "repository_mirrors_repository_index" ON "repository_mirrors" ("repository_id");
CREATE INDEX IF NOT EXISTS "repository_mirrors_due_index" ON "repository_mirrors" ("enabled", "last_synced_at");
CREATE UNIQUE INDEX IF NOT EXISTS "repository_mirrors_uuid_unique" ON "repository_mirrors" ("uuid");
