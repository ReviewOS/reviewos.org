ALTER TABLE "protected_branches" DROP CONSTRAINT IF EXISTS "protected_branches_repository_id_fk";
ALTER TABLE "protected_branches" ADD CONSTRAINT "protected_branches_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;
