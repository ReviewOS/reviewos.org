ALTER TABLE "authors" DROP CONSTRAINT IF EXISTS "authors_user_id_fk";
ALTER TABLE "authors" ADD CONSTRAINT "authors_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
