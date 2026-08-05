CREATE TABLE IF NOT EXISTS "audit_events" (
  "id" BIGSERIAL PRIMARY KEY,
  "action" varchar(80) not null,
  "subject_type" varchar(40),
  "subject_id" integer,
  "actor_id" integer REFERENCES "users"("id"),
  "external_actor" varchar(120),
  "reason" text,
  "detail" text,
  "ip_address" varchar(45),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE INDEX IF NOT EXISTS "audit_events_subject_index" ON "audit_events" ("subject_type", "subject_id", "created_at");
CREATE INDEX IF NOT EXISTS "audit_events_actor_index" ON "audit_events" ("actor_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "audit_events_uuid_unique" ON "audit_events" ("uuid");
