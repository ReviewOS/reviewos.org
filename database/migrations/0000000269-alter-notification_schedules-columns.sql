ALTER TABLE "notification_schedules" DROP CONSTRAINT IF EXISTS "notification_schedules_user_id_fk";
ALTER TABLE "notification_schedules" ADD CONSTRAINT "notification_schedules_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
