CREATE TABLE IF NOT EXISTS "repository_labels" (
  "id" BIGSERIAL PRIMARY KEY,
  "repository_id" integer not null REFERENCES "repositories"("id"),
  "name" varchar(50) not null,
  "color" varchar(6) not null default 'd4c5f9',
  "description" varchar(255),
  "is_default" boolean default false,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE INDEX IF NOT EXISTS "repository_labels_repository_labels_repository_name_index" ON "repository_labels" ("repository_id", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "repository_labels_repository_labels_uuid_unique" ON "repository_labels" ("uuid");
