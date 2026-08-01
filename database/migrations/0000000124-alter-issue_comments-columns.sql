ALTER TABLE "issue_comments" DROP CONSTRAINT IF EXISTS "issue_comments_author_id_fk";
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_author_id_fk" FOREIGN KEY ("author_id") REFERENCES "users"("id");
