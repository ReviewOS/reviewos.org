CREATE TABLE IF NOT EXISTS "payment_transactions" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(255) not null,
  "description" varchar(255),
  "amount" integer not null,
  "type" varchar(50) not null,
  "provider_id" varchar(255),
  "user_id" bigint REFERENCES "users"("id"),
  "payment_method_id" bigint REFERENCES "payment_methods"("id"),
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transactions_payment_transactions_uuid_unique" ON "payment_transactions" ("uuid");
