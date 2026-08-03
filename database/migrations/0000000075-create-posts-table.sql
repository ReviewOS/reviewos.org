CREATE TABLE IF NOT EXISTS "posts" (
  "id" BIGSERIAL PRIMARY KEY,
  "title" varchar(255) not null,
  "poster" varchar(255),
  "content" text not null,
  "excerpt" text,
  "views" integer default 0,
  "published_at" timestamp,
  "status" "posts_status_type" not null default 'draft',
  "is_featured" integer,
  "author_id" bigint REFERENCES "authors"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "posts_uuid_unique" ON "posts" ("uuid");
