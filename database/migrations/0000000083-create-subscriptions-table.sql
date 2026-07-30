CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id" BIGSERIAL PRIMARY KEY,
  "type" text not null,
  "plan" varchar(100),
  "provider_id" varchar(255) not null,
  "provider_status" varchar(255) not null,
  "unit_price" integer not null,
  "provider_type" varchar(255) not null,
  "provider_price_id" varchar(255),
  "quantity" integer,
  "trial_ends_at" timestamp,
  "ends_at" timestamp,
  "last_used_at" timestamp,
  "user_id" bigint REFERENCES "users"("id"),
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_subscriptions_provider_id_unique" ON "subscriptions" ("provider_id");
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_subscriptions_uuid_unique" ON "subscriptions" ("uuid");
