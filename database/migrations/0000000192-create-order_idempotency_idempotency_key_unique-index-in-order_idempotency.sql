CREATE UNIQUE INDEX IF NOT EXISTS "order_idempotency_idempotency_key_unique" ON "order_idempotency" ("idempotency_key");
