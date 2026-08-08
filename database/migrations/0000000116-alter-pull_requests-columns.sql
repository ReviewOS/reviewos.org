ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "auto_merge_strategy" "pull_requests_auto_merge_strategy_type";
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "auto_merge_by_id" bigint;
ALTER TABLE "pull_requests" DROP CONSTRAINT IF EXISTS "pull_requests_auto_merge_by_id_fk";
ALTER TABLE "pull_requests" DROP CONSTRAINT IF EXISTS "pull_requests_auto_merge_by_id_fkey";
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_auto_merge_by_id_fk" FOREIGN KEY ("auto_merge_by_id") REFERENCES "users"("id") ON DELETE SET NULL;
