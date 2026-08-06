CREATE TABLE IF NOT EXISTS "campaign_sends" (
  "id" BIGSERIAL PRIMARY KEY,
  "campaign_id" bigint not null REFERENCES "campaigns"("id"),
  "subscriber_id" bigint not null REFERENCES "subscribers"("id"),
  "email_list_id" bigint not null REFERENCES "email_lists"("id"),
  "status" "campaign_sends_status_type" not null default 'queued',
  "provider_message_id" varchar(255),
  "error" varchar(255),
  "sent_at" timestamp,
  "opened_at" timestamp,
  "clicked_at" timestamp,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_sends_uuid_unique" ON "campaign_sends" ("uuid");
