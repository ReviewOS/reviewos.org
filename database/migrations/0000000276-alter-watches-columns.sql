ALTER TABLE "watches" DROP CONSTRAINT IF EXISTS "watches_user_id_fk";
ALTER TABLE "watches" ADD CONSTRAINT "watches_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
