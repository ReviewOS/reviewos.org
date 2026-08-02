ALTER TABLE "issue_assignees" DROP CONSTRAINT IF EXISTS "issue_assignees_user_id_fk";
ALTER TABLE "issue_assignees" ADD CONSTRAINT "issue_assignees_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
