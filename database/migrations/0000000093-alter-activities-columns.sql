ALTER TABLE "activities" DROP CONSTRAINT IF EXISTS "activities_user_id_fk";
ALTER TABLE "activities" ADD CONSTRAINT "activities_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
