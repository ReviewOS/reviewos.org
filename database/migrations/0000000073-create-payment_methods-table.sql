CREATE TABLE IF NOT EXISTS "payment_methods" (
  "id" BIGSERIAL PRIMARY KEY,
  "type" text not null,
  "last_four" integer not null,
  "brand" varchar(50) not null,
  "exp_month" integer not null,
  "exp_year" integer not null,
  "is_default" boolean,
  "provider_id" varchar(255),
  "user_id" bigint REFERENCES "users"("id"),
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "payment_methods_uuid_unique" ON "payment_methods" ("uuid");
