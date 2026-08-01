ALTER TABLE "repository_mirrors" ADD COLUMN IF NOT EXISTS "metadata_failure_count" integer default 0;
