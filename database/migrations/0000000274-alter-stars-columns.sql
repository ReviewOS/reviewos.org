ALTER TABLE "stars" DROP CONSTRAINT IF EXISTS "stars_user_id_fk";
ALTER TABLE "stars" ADD CONSTRAINT "stars_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
