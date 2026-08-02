ALTER TABLE "access_tokens" DROP CONSTRAINT IF EXISTS "access_tokens_user_id_fk";
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
