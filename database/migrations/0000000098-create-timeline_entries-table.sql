CREATE TABLE IF NOT EXISTS "timeline_entries" (
  "id" BIGSERIAL PRIMARY KEY,
  "subject_type" "timeline_entries_subject_type_type" default 'issue',
  "subject_id" integer not null,
  "kind" "timeline_entries_kind_type",
  "actor_id" bigint REFERENCES "users"("id"),
  "external_actor" varchar(120),
  "subject_text" varchar(255),
  "previous_text" varchar(255),
  "reference_number" integer,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE INDEX IF NOT EXISTS "timeline_entries_subject_index" ON "timeline_entries" ("subject_type", "subject_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "timeline_entries_uuid_unique" ON "timeline_entries" ("uuid");
