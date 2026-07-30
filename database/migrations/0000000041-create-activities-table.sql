CREATE TABLE IF NOT EXISTS "activities" (
  "id" BIGSERIAL PRIMARY KEY,
  "type" varchar(50) not null,
  "description" text not null,
  "subject_type" varchar(100),
  "subject_id" integer,
  "causer" varchar(100),
  "properties" varchar(255),
  "ip_address" varchar(45),
  "user_id" bigint REFERENCES "users"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "activities_activities_uuid_unique" ON "activities" ("uuid");
