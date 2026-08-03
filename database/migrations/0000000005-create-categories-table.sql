CREATE TABLE IF NOT EXISTS "categories" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(50) not null,
  "description" varchar(255),
  "slug" varchar(255) not null,
  "image_url" varchar(255),
  "is_active" boolean,
  "parent_category_id" varchar(255),
  "display_order" integer not null,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "categories_uuid_unique" ON "categories" ("uuid");
