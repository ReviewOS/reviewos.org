ALTER TABLE "webhooks" DROP CONSTRAINT IF EXISTS "webhooks_repository_id_fk";
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;
