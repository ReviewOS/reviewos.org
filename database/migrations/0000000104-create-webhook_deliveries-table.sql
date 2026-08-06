CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id" BIGSERIAL PRIMARY KEY,
  "webhook_id" bigint not null REFERENCES "webhooks"("id"),
  "event" varchar(100) not null,
  "payload" text,
  "request_headers" text,
  "response_status" integer,
  "response_body" text,
  "duration_ms" integer,
  "attempt" integer default 1,
  "error" text,
  "delivered_at" varchar(255),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE INDEX IF NOT EXISTS "webhook_deliveries_webhook_index" ON "webhook_deliveries" ("webhook_id");
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_deliveries_uuid_unique" ON "webhook_deliveries" ("uuid");
