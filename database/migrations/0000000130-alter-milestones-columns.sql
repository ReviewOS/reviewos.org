ALTER TABLE "milestones" DROP CONSTRAINT IF EXISTS "milestones_repository_id_fk";
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;
