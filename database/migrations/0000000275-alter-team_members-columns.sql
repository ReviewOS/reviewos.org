ALTER TABLE "team_members" DROP CONSTRAINT IF EXISTS "team_members_user_id_fk";
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
