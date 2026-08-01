ALTER TABLE "repository_mirrors" ADD COLUMN IF NOT EXISTS "sync_metadata" boolean default false;
ALTER TABLE "repository_mirrors" ADD COLUMN IF NOT EXISTS "last_metadata_sync_at" varchar(255);
ALTER TABLE "repository_mirrors" ADD COLUMN IF NOT EXISTS "metadata_error" text;
