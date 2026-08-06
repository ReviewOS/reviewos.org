CREATE TABLE IF NOT EXISTS "notification_deliveries" (
  "id" BIGSERIAL PRIMARY KEY,
  "user_id" bigint REFERENCES "users"("id"),
  "channel" "notification_deliveries_channel_type" not null,
  "recipient" text not null,
  "subject" varchar(255),
  "body" text not null,
  "status" "notification_deliveries_status_type" not null default 'pending',
  "error" text,
  "metadata" varchar(255),
  "sent_at" timestamp,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
