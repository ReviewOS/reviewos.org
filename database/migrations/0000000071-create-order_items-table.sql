CREATE TABLE IF NOT EXISTS "order_items" (
  "id" BIGSERIAL PRIMARY KEY,
  "quantity" integer not null default 1,
  "price" integer not null,
  "special_instructions" varchar(255),
  "order_id" bigint REFERENCES "orders"("id"),
  "product_id" bigint REFERENCES "products"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
