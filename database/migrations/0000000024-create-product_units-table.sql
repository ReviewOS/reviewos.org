CREATE TABLE IF NOT EXISTS "product_units" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(100) not null,
  "abbreviation" varchar(10) not null,
  "type" varchar(255) not null,
  "description" varchar(255),
  "is_default" boolean,
  "product_id" bigint REFERENCES "products"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "product_units_uuid_unique" ON "product_units" ("uuid");
