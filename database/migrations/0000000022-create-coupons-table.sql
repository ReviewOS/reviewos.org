CREATE TABLE IF NOT EXISTS "coupons" (
  "id" BIGSERIAL PRIMARY KEY,
  "code" varchar(50) not null,
  "description" varchar(255),
  "status" "coupons_status_type",
  "is_active" boolean not null default true,
  "discount_type" "coupons_discount_type_type" not null,
  "discount_value" integer not null,
  "min_order_amount" integer,
  "max_discount_amount" integer,
  "free_product_id" varchar(255),
  "usage_limit" integer,
  "usage_count" integer,
  "start_date" date,
  "end_date" date,
  "product_id" bigint REFERENCES "products"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "coupons_coupons_code_unique" ON "coupons" ("code");
CREATE UNIQUE INDEX IF NOT EXISTS "coupons_coupons_uuid_unique" ON "coupons" ("uuid");
