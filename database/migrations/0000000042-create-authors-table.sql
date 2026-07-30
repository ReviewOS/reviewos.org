CREATE TABLE IF NOT EXISTS "authors" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(255) not null,
  "email" varchar(255) not null,
  "bio" text,
  "avatar" varchar(255),
  "user_id" bigint REFERENCES "users"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE INDEX IF NOT EXISTS "authors_authors_email_name_index" ON "authors" ("email", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "authors_authors_email_unique" ON "authors" ("email");
CREATE UNIQUE INDEX IF NOT EXISTS "authors_authors_uuid_unique" ON "authors" ("uuid");
