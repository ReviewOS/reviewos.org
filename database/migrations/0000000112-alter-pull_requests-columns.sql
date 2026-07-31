ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "closed_at" varchar(255);
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "closed_by_id" integer;
