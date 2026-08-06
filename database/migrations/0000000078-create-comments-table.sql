CREATE TABLE IF NOT EXISTS "comments" (
  "id" BIGSERIAL PRIMARY KEY,
  "author_name" varchar(100) not null,
  "author_email" varchar(255) not null,
  "content" text not null,
  "body" text,
  "post_title" varchar(255),
  "status" "comments_status_type" not null default 'pending',
  "ip_address" varchar(45),
  "user_agent" varchar(500),
  "is_approved" integer default 0,
  "post_id" bigint REFERENCES "posts"("id"),
  "user_id" bigint REFERENCES "users"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "comments_uuid_unique" ON "comments" ("uuid");
