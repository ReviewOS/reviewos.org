CREATE TABLE IF NOT EXISTS "ssh_keys" (
  "id" BIGSERIAL PRIMARY KEY,
  "user_id" integer not null REFERENCES "users"("id"),
  "title" varchar(100) not null,
  "key_type" "ssh_keys_key_type_type",
  "public_key" text not null,
  "fingerprint" varchar(100) not null,
  "last_used_at" varchar(255),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE INDEX IF NOT EXISTS "ssh_keys_ssh_keys_fingerprint_index" ON "ssh_keys" ("fingerprint");
CREATE UNIQUE INDEX IF NOT EXISTS "ssh_keys_ssh_keys_fingerprint_unique" ON "ssh_keys" ("fingerprint");
