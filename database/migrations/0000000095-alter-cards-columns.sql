ALTER TABLE "cards" DROP CONSTRAINT IF EXISTS "cards_user_id_fk";
ALTER TABLE "cards" ADD CONSTRAINT "cards_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
