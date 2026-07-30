CREATE TABLE IF NOT EXISTS "social_posts" (
  "id" BIGSERIAL PRIMARY KEY,
  "content" text not null,
  "platform" "social_posts_platform_type" not null,
  "status" "social_posts_status_type" not null default 'draft',
  "scheduled_at" timestamp,
  "published_at" timestamp,
  "likes" integer default 0,
  "shares" integer default 0,
  "comments" integer default 0,
  "reach" integer default 0,
  "image_url" varchar(255),
  "external_id" varchar(255),
  "user_id" bigint REFERENCES "users"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "social_posts_social_posts_uuid_unique" ON "social_posts" ("uuid");
