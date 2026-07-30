CREATE TABLE IF NOT EXISTS "tax_rates" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(255) not null,
  "rate" integer not null,
  "type" varchar(100) not null,
  "country" varchar(100) not null,
  "region" "tax_rates_region_type",
  "status" "tax_rates_status_type" default 'active',
  "is_default" boolean default false,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "tax_rates_tax_rates_uuid_unique" ON "tax_rates" ("uuid");
