CREATE TABLE IF NOT EXISTS "shipping_rates" (
  "id" BIGSERIAL PRIMARY KEY,
  "weight_from" real not null,
  "weight_to" real not null,
  "rate" integer not null,
  "shipping_method_id" bigint REFERENCES "shipping_methods"("id"),
  "shipping_zone_id" bigint REFERENCES "shipping_zones"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "shipping_rates_uuid_unique" ON "shipping_rates" ("uuid");
