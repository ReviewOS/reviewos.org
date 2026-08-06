CREATE TABLE IF NOT EXISTS "shipping_methods" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(100) not null,
  "description" varchar(500),
  "base_rate" integer not null,
  "free_shipping" integer,
  "status" "shipping_methods_status_type" not null,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "shipping_methods_uuid_unique" ON "shipping_methods" ("uuid");
