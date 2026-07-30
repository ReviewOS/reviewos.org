CREATE TABLE IF NOT EXISTS "products" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(100) not null,
  "description" varchar(255),
  "price" integer not null,
  "image_url" varchar(255),
  "is_available" boolean,
  "inventory_count" integer,
  "preparation_time" integer not null,
  "allergens" varchar(255),
  "nutritional_info" varchar(255),
  "category_id" bigint REFERENCES "categories"("id"),
  "manufacturer_id" bigint REFERENCES "manufacturers"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "products_products_uuid_unique" ON "products" ("uuid");
