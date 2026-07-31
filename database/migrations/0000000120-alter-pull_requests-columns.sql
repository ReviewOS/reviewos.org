ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "mergeable_base_sha" varchar(40);
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "mergeable_head_sha" varchar(40);
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "mergeable_conflicts" text;
