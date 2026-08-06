ALTER TABLE "access_token_repositories" DROP CONSTRAINT IF EXISTS "access_token_repositories_repository_id_fk";
ALTER TABLE "access_token_repositories" ADD CONSTRAINT "access_token_repositories_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;
