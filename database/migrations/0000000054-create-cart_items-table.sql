CREATE TABLE IF NOT EXISTS "cart_items" (
  "id" BIGSERIAL PRIMARY KEY,
  "quantity" integer not null,
  "unit_price" integer not null,
  "total_price" integer not null,
  "tax_rate" integer,
  "tax_amount" integer,
  "discount_percentage" integer,
  "discount_amount" integer,
  "product_name" varchar(255) not null,
  "product_sku" varchar(100),
  "product_image" varchar(255),
  "notes" varchar(500),
  "cart_id" bigint REFERENCES "carts"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "cart_items_uuid_unique" ON "cart_items" ("uuid");
