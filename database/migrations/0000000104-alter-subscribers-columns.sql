ALTER TABLE "subscribers" DROP CONSTRAINT IF EXISTS "subscribers_user_id_fk";
ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
