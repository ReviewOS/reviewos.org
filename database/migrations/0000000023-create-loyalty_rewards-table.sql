CREATE TABLE IF NOT EXISTS "loyalty_rewards" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(255) not null,
  "description" varchar(500),
  "points_required" integer not null,
  "reward_type" varchar(255) not null,
  "discount_percentage" integer,
  "free_product_id" varchar(255),
  "is_active" boolean,
  "expiry_days" integer,
  "image_url" varchar(255),
  "product_id" bigint REFERENCES "products"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "loyalty_rewards_uuid_unique" ON "loyalty_rewards" ("uuid");
