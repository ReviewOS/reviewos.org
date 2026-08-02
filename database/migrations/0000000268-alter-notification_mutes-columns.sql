ALTER TABLE "notification_mutes" DROP CONSTRAINT IF EXISTS "notification_mutes_user_id_fk";
ALTER TABLE "notification_mutes" ADD CONSTRAINT "notification_mutes_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
