ALTER TABLE "ssh_keys" DROP CONSTRAINT IF EXISTS "ssh_keys_user_id_fk";
ALTER TABLE "ssh_keys" ADD CONSTRAINT "ssh_keys_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
