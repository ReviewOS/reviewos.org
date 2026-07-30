CREATE TABLE IF NOT EXISTS "cards" (
  "id" BIGSERIAL PRIMARY KEY,
  "column_id" integer not null,
  "board_id" integer not null REFERENCES "boards"("id"),
  "title" text not null,
  "description" text,
  "position" integer,
  "created_by_user_id" integer,
  "due_date" varchar(255),
  "archived" boolean,
  "board_column_id" bigint REFERENCES "board_columns"("id"),
  "user_id" bigint REFERENCES "users"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "cards_cards_uuid_unique" ON "cards" ("uuid");
