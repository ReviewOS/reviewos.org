CREATE TABLE IF NOT EXISTS "loyalty_points" (
  "id" BIGSERIAL PRIMARY KEY,
  "wallet_id" varchar(255) not null,
  "points" integer not null,
  "source" varchar(255),
  "source_reference_id" varchar(255),
  "description" varchar(255),
  "expiry_date" timestamp,
  "is_used" boolean,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "loyalty_points_loyalty_points_uuid_unique" ON "loyalty_points" ("uuid");
