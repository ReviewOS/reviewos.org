ALTER TABLE "commit_statuses" DROP CONSTRAINT IF EXISTS "commit_statuses_repository_id_fkey";
ALTER TABLE "commit_statuses" DROP CONSTRAINT IF EXISTS "commit_statuses_repository_id_fkey";
ALTER TABLE "commit_statuses" ADD CONSTRAINT "commit_statuses_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;
ALTER TABLE "deployments" DROP CONSTRAINT IF EXISTS "deployments_repository_id_fkey";
ALTER TABLE "deployments" DROP CONSTRAINT IF EXISTS "deployments_repository_id_fkey";
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;
ALTER TABLE "workflow_notification_rules" DROP CONSTRAINT IF EXISTS "workflow_notification_rules_repository_id_fkey";
ALTER TABLE "workflow_notification_rules" DROP CONSTRAINT IF EXISTS "workflow_notification_rules_repository_id_fkey";
ALTER TABLE "workflow_notification_rules" ADD CONSTRAINT "workflow_notification_rules_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;
