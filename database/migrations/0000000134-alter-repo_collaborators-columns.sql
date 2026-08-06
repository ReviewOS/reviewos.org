ALTER TABLE "repo_collaborators" DROP CONSTRAINT IF EXISTS "repo_collaborators_repository_id_fk";
ALTER TABLE "repo_collaborators" ADD CONSTRAINT "repo_collaborators_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;
