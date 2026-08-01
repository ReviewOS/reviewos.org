ALTER TABLE "pull_requests" DROP CONSTRAINT IF EXISTS "pull_requests_author_id_fk";
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_author_id_fk" FOREIGN KEY ("author_id") REFERENCES "users"("id");
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "external_author" varchar(120);
