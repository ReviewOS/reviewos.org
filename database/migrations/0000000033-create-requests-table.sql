CREATE TABLE IF NOT EXISTS "requests" (
  "id" BIGSERIAL PRIMARY KEY,
  "method" "requests_method_type",
  "path" varchar(255),
  "status_code" integer,
  "duration_ms" integer,
  "ip_address" varchar(255),
  "memory_usage" integer,
  "user_agent" varchar(255),
  "error_message" varchar(255),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "deleted_at" timestamp
);
