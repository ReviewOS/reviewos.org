ALTER TABLE "attachments" DROP CONSTRAINT IF EXISTS "attachments_repository_id_fk";
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;
