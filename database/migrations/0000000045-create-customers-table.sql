CREATE TABLE IF NOT EXISTS "customers" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(255) not null,
  "email" varchar(255) not null,
  "phone" varchar(50) not null,
  "total_spent" integer default 0,
  "last_order" varchar(255),
  "status" "customers_status_type" not null default 'Active',
  "avatar" varchar(255) not null,
  "user_id" bigint REFERENCES "users"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "customers_customers_email_unique" ON "customers" ("email");
CREATE UNIQUE INDEX IF NOT EXISTS "customers_customers_uuid_unique" ON "customers" ("uuid");
