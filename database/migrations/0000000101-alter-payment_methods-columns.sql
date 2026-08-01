ALTER TABLE "payment_methods" DROP CONSTRAINT IF EXISTS "payment_methods_user_id_fk";
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
