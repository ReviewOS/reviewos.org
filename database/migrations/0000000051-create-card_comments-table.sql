CREATE TABLE IF NOT EXISTS "card_comments" (
  "id" BIGSERIAL PRIMARY KEY,
  "card_id" bigint not null REFERENCES "cards"("id"),
  "user_id" bigint REFERENCES "users"("id"),
  "body" text not null,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "card_comments_uuid_unique" ON "card_comments" ("uuid");
