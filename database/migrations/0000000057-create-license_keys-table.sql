CREATE TABLE IF NOT EXISTS "license_keys" (
  "id" BIGSERIAL PRIMARY KEY,
  "key" varchar(255) not null,
  "template" "license_keys_template_type" not null,
  "expiry_date" timestamp not null,
  "status" "license_keys_status_type" default 'unassigned',
  "customer_id" bigint REFERENCES "customers"("id"),
  "product_id" bigint REFERENCES "products"("id"),
  "order_id" bigint REFERENCES "orders"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "license_keys_license_keys_key_unique" ON "license_keys" ("key");
CREATE UNIQUE INDEX IF NOT EXISTS "license_keys_license_keys_uuid_unique" ON "license_keys" ("uuid");
