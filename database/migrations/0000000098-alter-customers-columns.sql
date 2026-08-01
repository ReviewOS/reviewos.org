ALTER TABLE "customers" DROP CONSTRAINT IF EXISTS "customers_user_id_fk";
ALTER TABLE "customers" ADD CONSTRAINT "customers_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
