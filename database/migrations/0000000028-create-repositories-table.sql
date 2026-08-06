CREATE TABLE IF NOT EXISTS "repositories" (
  "id" BIGSERIAL PRIMARY KEY,
  "owner_type" "repositories_owner_type_type",
  "owner_id" integer not null,
  "name" varchar(100) not null,
  "description" text,
  "visibility" "repositories_visibility_type" default 'public',
  "default_branch" varchar(255) default 'main',
  "disk_path" varchar(512),
  "is_fork" boolean default false,
  "parent_id" bigint REFERENCES "repositories"("id") ON DELETE SET NULL,
  "is_archived" boolean default false,
  "is_template" boolean default false,
  "size_kb" integer default 0,
  "stars_count" integer default 0,
  "forks_count" integer default 0,
  "open_issues_count" integer default 0,
  "issue_counter" integer default 0,
  "pushed_at" varchar(255),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "repositories_owner_name_index" ON "repositories" ("owner_type", "owner_id", "name");
CREATE INDEX IF NOT EXISTS "repositories_pushed_at_index" ON "repositories" ("pushed_at");
CREATE UNIQUE INDEX IF NOT EXISTS "repositories_uuid_unique" ON "repositories" ("uuid");
