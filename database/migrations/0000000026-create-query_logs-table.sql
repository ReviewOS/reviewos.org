CREATE TABLE IF NOT EXISTS "query_logs" (
  "id" BIGSERIAL PRIMARY KEY,
  "query" text not null,
  "normalized_query" text,
  "duration" integer default 0,
  "connection" varchar(255) default 'unknown',
  "status" "query_logs_status_type" default 'completed',
  "error" text,
  "executed_at" varchar(255) not null,
  "bindings" text,
  "trace" text,
  "model" varchar(255),
  "method" varchar(255),
  "file" varchar(255),
  "line" integer,
  "memory_usage" integer,
  "rows_affected" integer,
  "transaction_id" varchar(255),
  "tags" varchar(255),
  "affected_tables" varchar(255),
  "indexes_used" varchar(255),
  "missing_indexes" varchar(255),
  "explain_plan" varchar(255),
  "optimization_suggestions" varchar(255),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE INDEX IF NOT EXISTS "query_logs_executed_at_index" ON "query_logs" ("executed_at");
CREATE INDEX IF NOT EXISTS "query_logs_status_index" ON "query_logs" ("status");
CREATE INDEX IF NOT EXISTS "query_logs_duration_index" ON "query_logs" ("duration");
