ALTER TABLE "releases" ALTER COLUMN "type" DROP DEFAULT;
ALTER TABLE "releases" ALTER COLUMN "type" TYPE varchar(255) USING "type"::varchar(255);
ALTER TABLE "releases" ALTER COLUMN "type" DROP NOT NULL;
ALTER TABLE "releases" ALTER COLUMN "notes" DROP DEFAULT;
ALTER TABLE "releases" ALTER COLUMN "notes" TYPE text USING "notes"::text;
ALTER TABLE "releases" ALTER COLUMN "notes" DROP NOT NULL;
