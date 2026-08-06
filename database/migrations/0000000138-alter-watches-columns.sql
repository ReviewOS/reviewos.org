ALTER TABLE "watches" DROP CONSTRAINT IF EXISTS "watches_repository_id_fk";
ALTER TABLE "watches" ADD CONSTRAINT "watches_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;
