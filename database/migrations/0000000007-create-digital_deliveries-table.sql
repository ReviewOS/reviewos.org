CREATE TABLE IF NOT EXISTS "digital_deliveries" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(255) not null,
  "description" varchar(255) not null,
  "download_limit" integer,
  "expiry_days" integer not null,
  "requires_login" boolean default false,
  "automatic_delivery" boolean default false,
  "status" "digital_deliveries_status_type" default 'active',
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "digital_deliveries_digital_deliveries_uuid_unique" ON "digital_deliveries" ("uuid");
