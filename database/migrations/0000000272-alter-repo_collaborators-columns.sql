ALTER TABLE "repo_collaborators" DROP CONSTRAINT IF EXISTS "repo_collaborators_user_id_fk";
ALTER TABLE "repo_collaborators" ADD CONSTRAINT "repo_collaborators_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
