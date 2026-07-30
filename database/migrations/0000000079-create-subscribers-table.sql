CREATE TABLE IF NOT EXISTS "subscribers" (
  "id" BIGSERIAL PRIMARY KEY,
  "email" varchar(255) not null,
  "status" "subscribers_status_type" not null default 'subscribed',
  "source" varchar(100) default 'homepage',
  "unsubscribed_at" timestamp,
  "user_id" bigint REFERENCES "users"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "subscribers_subscribers_email_unique" ON "subscribers" ("email");
CREATE UNIQUE INDEX IF NOT EXISTS "subscribers_subscribers_uuid_unique" ON "subscribers" ("uuid");
