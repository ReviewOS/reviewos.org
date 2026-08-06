CREATE TABLE IF NOT EXISTS "transactions" (
  "id" BIGSERIAL PRIMARY KEY,
  "amount" integer not null,
  "status" varchar(255) not null,
  "payment_method" varchar(255) not null,
  "payment_details" varchar(255),
  "transaction_reference" varchar(255),
  "loyalty_points_earned" integer,
  "loyalty_points_redeemed" integer,
  "order_id" bigint REFERENCES "orders"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "transactions_uuid_unique" ON "transactions" ("uuid");
