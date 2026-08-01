ALTER TABLE "issues" DROP CONSTRAINT IF EXISTS "issues_author_id_fk";
ALTER TABLE "issues" ADD CONSTRAINT "issues_author_id_fk" FOREIGN KEY ("author_id") REFERENCES "users"("id");
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "external_author" varchar(120);
