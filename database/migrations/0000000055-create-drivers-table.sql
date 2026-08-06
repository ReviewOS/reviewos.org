CREATE TABLE IF NOT EXISTS "drivers" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(255) not null,
  "phone" varchar(255) not null,
  "vehicle_number" varchar(255) not null,
  "license" varchar(255) not null,
  "status" "drivers_status_type" default 'active',
  "user_id" bigint REFERENCES "users"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "drivers_uuid_unique" ON "drivers" ("uuid");
