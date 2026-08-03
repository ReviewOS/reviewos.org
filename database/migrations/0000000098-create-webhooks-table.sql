CREATE TABLE IF NOT EXISTS "webhooks" (
  "id" BIGSERIAL PRIMARY KEY,
  "repository_id" integer not null REFERENCES "repositories"("id"),
  "url" text not null,
  "secret" varchar(255),
  "events" text default '["*"]',
  "content_type" "webhooks_content_type_type" default 'application/json',
  "active" boolean default true,
  "consecutive_failures" integer default 0,
  "last_success_at" varchar(255),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE INDEX IF NOT EXISTS "webhooks_repository_index" ON "webhooks" ("repository_id");
CREATE UNIQUE INDEX IF NOT EXISTS "webhooks_uuid_unique" ON "webhooks" ("uuid");
