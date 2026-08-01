ALTER TABLE "payment_transactions" DROP CONSTRAINT IF EXISTS "payment_transactions_user_id_fk";
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
