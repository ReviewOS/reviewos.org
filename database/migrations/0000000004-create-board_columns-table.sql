CREATE TABLE IF NOT EXISTS "board_columns" (
  "id" BIGSERIAL PRIMARY KEY,
  "board_id" integer not null REFERENCES "boards"("id"),
  "name" varchar(80) not null,
  "position" integer,
  "card_limit" integer,
  "color" varchar(40),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "board_columns_board_columns_uuid_unique" ON "board_columns" ("uuid");
