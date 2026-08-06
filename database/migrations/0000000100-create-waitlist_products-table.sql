CREATE TABLE IF NOT EXISTS "waitlist_products" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(255) not null,
  "email" varchar(255) not null,
  "phone" varchar(100),
  "quantity" integer not null,
  "notification_preference" "waitlist_products_notification_preference_type" not null,
  "source" varchar(100) not null,
  "notes" varchar(500),
  "status" "waitlist_products_status_type" not null default 'waiting',
  "notified_at" date,
  "purchased_at" date,
  "cancelled_at" date,
  "product_id" bigint REFERENCES "products"("id"),
  "customer_id" bigint REFERENCES "customers"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "waitlist_products_uuid_unique" ON "waitlist_products" ("uuid");
