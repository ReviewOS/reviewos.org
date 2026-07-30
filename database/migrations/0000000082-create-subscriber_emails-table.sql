CREATE TABLE IF NOT EXISTS "subscriber_emails" (
  "id" BIGSERIAL PRIMARY KEY,
  "email" varchar(255) not null,
  "source" varchar(100) default 'homepage',
  "subscriber_id" bigint REFERENCES "subscribers"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "subscriber_emails_subscriber_emails_uuid_unique" ON "subscriber_emails" ("uuid");
