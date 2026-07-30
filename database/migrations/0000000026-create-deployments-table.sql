CREATE TABLE IF NOT EXISTS "deployments" (
  "id" BIGSERIAL PRIMARY KEY,
  "commit_hash" varchar(40) not null,
  "commit_message" text,
  "branch" varchar(255) not null,
  "status" varchar(255) not null,
  "environment" varchar(255) not null,
  "duration" integer,
  "author" varchar(255) not null,
  "url" text,
  "error_log" varchar(255),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "deployments_deployments_uuid_unique" ON "deployments" ("uuid");
