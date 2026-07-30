ALTER TABLE "card_comments" DROP CONSTRAINT IF EXISTS "card_comments_user_id_fk";
ALTER TABLE "card_comments" ADD CONSTRAINT "card_comments_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
