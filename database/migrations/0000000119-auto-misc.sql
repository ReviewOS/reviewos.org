ALTER TABLE "jobs" ALTER COLUMN "payload" DROP DEFAULT;
ALTER TABLE "jobs" ALTER COLUMN "payload" TYPE text USING "payload"::text;
ALTER TABLE "jobs" ALTER COLUMN "payload" SET NOT NULL;
ALTER TABLE "jobs" ALTER COLUMN "reserved_at" DROP DEFAULT;
ALTER TABLE "jobs" ALTER COLUMN "reserved_at" TYPE integer USING NULL::integer;
ALTER TABLE "jobs" ALTER COLUMN "reserved_at" DROP NOT NULL;
