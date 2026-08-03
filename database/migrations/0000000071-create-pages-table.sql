CREATE TABLE IF NOT EXISTS "pages" (
  "id" BIGSERIAL PRIMARY KEY,
  "title" varchar(255) not null,
  "template" varchar(255) not null,
  "views" integer default 0,
  "published_at" timestamp,
  "conversions" integer default 0,
  "author_id" bigint REFERENCES "authors"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "pages_uuid_unique" ON "pages" ("uuid");
