CREATE TABLE IF NOT EXISTS "product_variants" (
  "id" BIGSERIAL PRIMARY KEY,
  "variant" varchar(100) not null,
  "type" varchar(50) not null,
  "description" varchar(255),
  "options" varchar(255),
  "status" "product_variants_status_type" not null,
  "product_id" bigint REFERENCES "products"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "product_variants_uuid_unique" ON "product_variants" ("uuid");
