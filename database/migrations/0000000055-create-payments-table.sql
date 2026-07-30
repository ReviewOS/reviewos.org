CREATE TABLE IF NOT EXISTS "payments" (
  "id" BIGSERIAL PRIMARY KEY,
  "amount" integer not null,
  "method" "payments_method_type" not null,
  "status" "payments_status_type" not null default 'pending',
  "currency" varchar(3) default 'USD',
  "reference_number" varchar(255),
  "card_last_four" varchar(4),
  "card_brand" varchar(255),
  "billing_email" varchar(255),
  "transaction_id" varchar(255),
  "payment_provider" varchar(255),
  "refund_amount" integer default 0,
  "notes" varchar(255),
  "order_id" bigint REFERENCES "orders"("id"),
  "customer_id" bigint REFERENCES "customers"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "payments_payments_transaction_id_unique" ON "payments" ("transaction_id");
CREATE UNIQUE INDEX IF NOT EXISTS "payments_payments_uuid_unique" ON "payments" ("uuid");
