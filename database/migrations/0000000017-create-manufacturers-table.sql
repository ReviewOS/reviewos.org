CREATE TABLE IF NOT EXISTS "manufacturers" (
  "id" BIGSERIAL PRIMARY KEY,
  "manufacturer" varchar(100) not null,
  "description" text,
  "country" varchar(100) not null,
  "featured" boolean,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "manufacturers_manufacturers_manufacturer_unique" ON "manufacturers" ("manufacturer");
CREATE UNIQUE INDEX IF NOT EXISTS "manufacturers_manufacturers_uuid_unique" ON "manufacturers" ("uuid");
