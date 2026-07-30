CREATE TABLE IF NOT EXISTS "shipping_zones" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(100) not null,
  "countries" text,
  "regions" text,
  "postal_codes" text,
  "status" "shipping_zones_status_type" not null,
  "shipping_method_id" bigint REFERENCES "shipping_methods"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "shipping_zones_shipping_zones_uuid_unique" ON "shipping_zones" ("uuid");
