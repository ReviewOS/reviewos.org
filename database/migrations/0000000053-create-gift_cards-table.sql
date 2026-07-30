CREATE TABLE IF NOT EXISTS "gift_cards" (
  "id" BIGSERIAL PRIMARY KEY,
  "code" varchar(50) not null,
  "initial_balance" integer not null,
  "current_balance" integer not null,
  "currency" varchar(3),
  "status" varchar(255) not null,
  "purchaser_id" varchar(255),
  "recipient_email" varchar(255),
  "recipient_name" varchar(255),
  "personal_message" varchar(255),
  "is_digital" boolean,
  "is_reloadable" boolean,
  "is_active" boolean default true,
  "expiry_date" timestamp,
  "last_used_date" timestamp,
  "template_id" varchar(255),
  "customer_id" bigint REFERENCES "customers"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "gift_cards_gift_cards_code_unique" ON "gift_cards" ("code");
CREATE UNIQUE INDEX IF NOT EXISTS "gift_cards_gift_cards_uuid_unique" ON "gift_cards" ("uuid");
