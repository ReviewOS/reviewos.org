CREATE TABLE IF NOT EXISTS "jobs" (
  "id" BIGSERIAL PRIMARY KEY,
  "queue" varchar(255) not null,
  "payload" varchar(255) not null,
  "attempts" integer,
  "available_at" integer,
  "reserved_at" date,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
