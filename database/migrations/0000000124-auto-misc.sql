ALTER TABLE "attachments" ALTER COLUMN "repository_id" DROP DEFAULT;
ALTER TABLE "attachments" ALTER COLUMN "repository_id" TYPE bigint USING "repository_id"::bigint;
ALTER TABLE "attachments" ALTER COLUMN "repository_id" SET NOT NULL;
