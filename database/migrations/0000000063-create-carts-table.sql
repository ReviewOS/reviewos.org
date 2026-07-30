CREATE TABLE IF NOT EXISTS "carts" (
  "id" BIGSERIAL PRIMARY KEY,
  "status" "carts_status_type" default 'active',
  "total_items" integer default 0,
  "subtotal" integer default 0,
  "tax_amount" integer default 0,
  "discount_amount" integer default 0,
  "total" integer default 0,
  "expires_at" timestamp not null,
  "currency" varchar(3) default 'USD',
  "notes" text,
  "applied_coupon_id" varchar(255) not null,
  "customer_id" bigint REFERENCES "customers"("id"),
  "coupon_id" bigint REFERENCES "coupons"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "carts_carts_uuid_unique" ON "carts" ("uuid");
