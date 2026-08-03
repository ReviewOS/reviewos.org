CREATE TABLE IF NOT EXISTS "waitlist_restaurants" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(255) not null,
  "email" varchar(255) not null,
  "phone" varchar(100),
  "party_size" integer not null,
  "check_in_time" timestamp not null,
  "table_preference" "waitlist_restaurants_table_preference_type" not null,
  "status" "waitlist_restaurants_status_type" not null default 'waiting',
  "quoted_wait_time" integer not null,
  "actual_wait_time" integer,
  "queue_position" integer,
  "seated_at" timestamp,
  "no_show_at" timestamp,
  "cancelled_at" timestamp,
  "customer_id" bigint REFERENCES "customers"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
CREATE UNIQUE INDEX IF NOT EXISTS "waitlist_restaurants_uuid_unique" ON "waitlist_restaurants" ("uuid");
