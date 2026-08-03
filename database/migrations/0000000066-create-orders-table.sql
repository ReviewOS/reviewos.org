CREATE TABLE IF NOT EXISTS "orders" (
  "id" BIGSERIAL PRIMARY KEY,
  "status" varchar(255) not null,
  "total_amount" integer not null,
  "currency" varchar(3) not null default 'USD',
  "tax_amount" integer,
  "discount_amount" integer,
  "delivery_fee" integer,
  "tip_amount" integer,
  "order_type" varchar(255) not null,
  "delivery_address" varchar(255),
  "special_instructions" varchar(255),
  "estimated_delivery_time" varchar(255),
  "applied_coupon_id" varchar(255),
  "customer_id" bigint REFERENCES "customers"("id"),
  "coupon_id" bigint REFERENCES "coupons"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "orders_uuid_unique" ON "orders" ("uuid");
