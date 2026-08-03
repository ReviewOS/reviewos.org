CREATE TABLE IF NOT EXISTS "gpg_keys" (
  "id" BIGSERIAL PRIMARY KEY,
  "user_id" integer not null REFERENCES "users"("id"),
  "key_id" varchar(64) not null,
  "public_key" text not null,
  "emails" text,
  "expires_at" varchar(255),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE INDEX IF NOT EXISTS "gpg_keys_key_id_index" ON "gpg_keys" ("key_id");
CREATE UNIQUE INDEX IF NOT EXISTS "gpg_keys_key_id_unique" ON "gpg_keys" ("key_id");
