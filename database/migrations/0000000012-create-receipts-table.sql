CREATE TABLE IF NOT EXISTS "receipts" (
  "id" BIGSERIAL PRIMARY KEY,
  "printer" varchar(100),
  "document" varchar(100) not null,
  "timestamp" timestamptz not null,
  "status" "receipts_status_type" not null,
  "size" integer,
  "pages" integer,
  "duration" integer,
  "metadata" varchar(255) default '{}',
  "print_device_id" bigint REFERENCES "print_devices"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "receipts_receipts_uuid_unique" ON "receipts" ("uuid");
