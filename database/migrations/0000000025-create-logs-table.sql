CREATE TABLE IF NOT EXISTS "logs" (
  "id" BIGSERIAL PRIMARY KEY,
  "timestamp" integer not null,
  "type" "logs_type_type" not null,
  "source" "logs_source_type" not null,
  "message" text not null,
  "project" varchar(255) not null,
  "stacktrace" text not null,
  "file" varchar(255) not null,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
