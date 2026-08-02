ALTER TABLE "gpg_keys" DROP CONSTRAINT IF EXISTS "gpg_keys_user_id_fk";
ALTER TABLE "gpg_keys" ADD CONSTRAINT "gpg_keys_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
