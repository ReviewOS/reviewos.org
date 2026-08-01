ALTER TABLE "comments" DROP CONSTRAINT IF EXISTS "comments_user_id_fk";
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
