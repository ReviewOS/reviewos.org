CREATE TABLE IF NOT EXISTS "labels" (
  "id" BIGSERIAL PRIMARY KEY,
  "board_id" integer not null REFERENCES "boards"("id"),
  "name" varchar(60) not null,
  "color" varchar(40),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "labels_labels_uuid_unique" ON "labels" ("uuid");
