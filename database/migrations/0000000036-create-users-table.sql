CREATE TABLE IF NOT EXISTS "users" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(100) not null,
  "email" varchar(255) not null,
  "password" varchar(255) not null,
  "avatar" text,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE INDEX IF NOT EXISTS "users_users_email_name_index" ON "users" ("email", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "users_users_email_unique" ON "users" ("email");
CREATE UNIQUE INDEX IF NOT EXISTS "users_users_uuid_unique" ON "users" ("uuid");
