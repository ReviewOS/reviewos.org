CREATE TABLE IF NOT EXISTS "organizations" (
  "id" BIGSERIAL PRIMARY KEY,
  "handle" varchar(39) not null,
  "name" varchar(100),
  "description" text,
  "avatar_url" text,
  "website" text,
  "billing_email" varchar(255),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE INDEX IF NOT EXISTS "organizations_organizations_handle_index" ON "organizations" ("handle");
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_organizations_handle_unique" ON "organizations" ("handle");
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_organizations_uuid_unique" ON "organizations" ("uuid");
