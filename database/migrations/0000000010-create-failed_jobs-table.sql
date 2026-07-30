CREATE TABLE IF NOT EXISTS "failed_jobs" (
  "id" BIGSERIAL PRIMARY KEY,
  "connection" varchar(100) not null,
  "queue" varchar(255) not null,
  "payload" varchar(255) not null,
  "exception" varchar(255) not null,
  "failed_at" date,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
