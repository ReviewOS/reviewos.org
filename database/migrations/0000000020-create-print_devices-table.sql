CREATE TABLE IF NOT EXISTS "print_devices" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(100) not null,
  "mac_address" varchar(50) not null,
  "location" varchar(100) not null,
  "terminal" varchar(50) not null,
  "status" "print_devices_status_type" not null,
  "last_ping" varchar(255) not null,
  "print_count" integer not null,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "print_devices_print_devices_uuid_unique" ON "print_devices" ("uuid");
