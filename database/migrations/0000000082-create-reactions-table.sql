CREATE TABLE IF NOT EXISTS "reactions" (
  "id" BIGSERIAL PRIMARY KEY,
  "subject_type" "reactions_subject_type_type" default 'issue',
  "subject_id" integer not null,
  "user_id" bigint not null REFERENCES "users"("id"),
  "content" "reactions_content_type" not null,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE INDEX IF NOT EXISTS "reactions_subject_index" ON "reactions" ("subject_type", "subject_id");
CREATE UNIQUE INDEX IF NOT EXISTS "reactions_one_per_person_index" ON "reactions" ("subject_type", "subject_id", "user_id", "content");
CREATE UNIQUE INDEX IF NOT EXISTS "reactions_uuid_unique" ON "reactions" ("uuid");
