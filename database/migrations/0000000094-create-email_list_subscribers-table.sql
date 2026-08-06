CREATE TABLE IF NOT EXISTS "email_list_subscribers" (
  "id" BIGSERIAL PRIMARY KEY,
  "email_list_id" bigint not null REFERENCES "email_lists"("id"),
  "subscriber_id" bigint not null REFERENCES "subscribers"("id"),
  "status" "email_list_subscribers_status_type" not null default 'subscribed',
  "source" varchar(100) default 'api',
  "subscribed_at" timestamp,
  "unsubscribed_at" timestamp,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "email_list_subscribers_uuid_unique" ON "email_list_subscribers" ("uuid");
