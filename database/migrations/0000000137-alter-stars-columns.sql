ALTER TABLE "stars" DROP CONSTRAINT IF EXISTS "stars_repository_id_fk";
ALTER TABLE "stars" ADD CONSTRAINT "stars_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;
