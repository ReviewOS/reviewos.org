ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "subscriptions_user_id_fk";
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
