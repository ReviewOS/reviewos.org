ALTER TABLE "check_runs" DROP CONSTRAINT IF EXISTS "check_runs_repository_id_fk";
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;
