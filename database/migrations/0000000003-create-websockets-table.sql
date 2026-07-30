CREATE TABLE IF NOT EXISTS "websockets" (
  "id" BIGSERIAL PRIMARY KEY,
  "type" "websockets_type_type" not null,
  "socket" varchar(255) not null,
  "details" text not null,
  "time" integer not null,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
