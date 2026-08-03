CREATE TABLE IF NOT EXISTS "notifications" (
  "id" BIGSERIAL PRIMARY KEY,
  "type" varchar(255) not null,
  "data" varchar(255) not null,
  "read_at" timestamp,
  "user_id" bigint REFERENCES "users"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_uuid_unique" ON "notifications" ("uuid");
