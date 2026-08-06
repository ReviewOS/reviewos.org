ALTER TABLE "releases" DROP CONSTRAINT IF EXISTS "releases_repository_id_fk";
ALTER TABLE "releases" ADD CONSTRAINT "releases_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;
