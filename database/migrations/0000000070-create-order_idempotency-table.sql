CREATE TABLE IF NOT EXISTS "order_idempotency" (
  "id" BIGSERIAL PRIMARY KEY,
  "idempotency_key" varchar(255) not null,
  "order_id" bigint not null REFERENCES "orders"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS "order_idempotency_idempotency_key_unique" ON "order_idempotency" ("idempotency_key");
