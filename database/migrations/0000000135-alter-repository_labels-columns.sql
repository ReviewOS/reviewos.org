ALTER TABLE "repository_labels" DROP CONSTRAINT IF EXISTS "repository_labels_repository_id_fk";
ALTER TABLE "repository_labels" ADD CONSTRAINT "repository_labels_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;
