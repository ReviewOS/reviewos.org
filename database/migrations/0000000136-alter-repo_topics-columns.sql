ALTER TABLE "repo_topics" DROP CONSTRAINT IF EXISTS "repo_topics_repository_id_fk";
ALTER TABLE "repo_topics" ADD CONSTRAINT "repo_topics_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;
