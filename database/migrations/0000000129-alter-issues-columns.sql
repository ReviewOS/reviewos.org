ALTER TABLE "issues" DROP CONSTRAINT IF EXISTS "issues_repository_id_fk";
ALTER TABLE "issues" ADD CONSTRAINT "issues_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;
