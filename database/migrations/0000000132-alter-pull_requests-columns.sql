ALTER TABLE "pull_requests" DROP CONSTRAINT IF EXISTS "pull_requests_repository_id_fk";
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;
