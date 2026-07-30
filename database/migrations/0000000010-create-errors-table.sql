CREATE TABLE IF NOT EXISTS "errors" (
  "id" BIGSERIAL PRIMARY KEY,
  "type" varchar(255) not null,
  "message" varchar(255) not null,
  "stack" varchar(255),
  "status" integer,
  "additional_info" varchar(255),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
