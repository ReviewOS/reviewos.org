ALTER TABLE "repository_mirrors" DROP CONSTRAINT IF EXISTS "repository_mirrors_repository_id_fk";
ALTER TABLE "repository_mirrors" ADD CONSTRAINT "repository_mirrors_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;
