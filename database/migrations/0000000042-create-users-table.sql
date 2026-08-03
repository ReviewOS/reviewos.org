CREATE TABLE IF NOT EXISTS "users" (
  "id" BIGSERIAL PRIMARY KEY,
  "handle" varchar(39) not null,
  "name" varchar(100),
  "email" varchar(255) not null,
  "password" varchar(255) not null,
  "bio" text,
  "avatar_url" text,
  "location" varchar(100),
  "website" text,
  "is_admin" boolean default false,
  "email_verified_at" varchar(255),
  "github_username" varchar(39),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE INDEX IF NOT EXISTS "users_handle_index" ON "users" ("handle");
CREATE UNIQUE INDEX IF NOT EXISTS "users_handle_unique" ON "users" ("handle");
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" ("email");
CREATE UNIQUE INDEX IF NOT EXISTS "users_github_username_unique" ON "users" ("github_username");
CREATE UNIQUE INDEX IF NOT EXISTS "users_uuid_unique" ON "users" ("uuid");
