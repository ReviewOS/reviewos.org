ALTER TABLE "notification_subscriptions" DROP CONSTRAINT IF EXISTS "notification_subscriptions_user_id_fk";
ALTER TABLE "notification_subscriptions" DROP CONSTRAINT IF EXISTS "notification_subscriptions_user_id_fkey";
ALTER TABLE "notification_subscriptions" ADD CONSTRAINT "notification_subscriptions_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
