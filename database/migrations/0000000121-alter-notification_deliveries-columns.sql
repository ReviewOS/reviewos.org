ALTER TABLE "notification_deliveries" DROP CONSTRAINT IF EXISTS "notification_deliveries_user_id_fk";
ALTER TABLE "notification_deliveries" DROP CONSTRAINT IF EXISTS "notification_deliveries_user_id_fkey";
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;
