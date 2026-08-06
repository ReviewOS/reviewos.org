CREATE TABLE IF NOT EXISTS "email_lists" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(100) not null,
  "slug" varchar(120),
  "description" varchar(500),
  "subscriber_count" integer default 0,
  "active_count" integer default 0,
  "unsubscribed_count" integer default 0,
  "bounced_count" integer default 0,
  "status" "email_lists_status_type" not null default 'active',
  "is_public" integer default 1,
  "double_opt_in" integer default 1,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "email_lists_slug_unique" ON "email_lists" ("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "email_lists_uuid_unique" ON "email_lists" ("uuid");
