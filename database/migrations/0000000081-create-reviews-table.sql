CREATE TABLE IF NOT EXISTS "reviews" (
  "id" BIGSERIAL PRIMARY KEY,
  "rating" integer not null,
  "title" varchar(100) not null,
  "content" text not null,
  "is_verified_purchase" boolean,
  "is_approved" boolean,
  "is_featured" boolean,
  "helpful_votes" integer default 0,
  "unhelpful_votes" integer default 0,
  "purchase_date" varchar(255),
  "images" varchar(255),
  "product_id" bigint REFERENCES "products"("id"),
  "customer_id" bigint REFERENCES "customers"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "reviews_uuid_unique" ON "reviews" ("uuid");
