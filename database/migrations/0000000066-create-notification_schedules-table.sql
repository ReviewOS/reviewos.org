CREATE TABLE IF NOT EXISTS "notification_schedules" (
  "id" BIGSERIAL PRIMARY KEY,
  "user_id" bigint not null REFERENCES "users"("id"),
  "days" varchar(20) default '1,2,3,4,5',
  "starts_at" integer default 540,
  "ends_at" integer default 1080,
  "timezone" varchar(64) default 'UTC',
  "breaks_through" varchar(500) default '',
  "do_not_disturb_until" varchar(255),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE INDEX IF NOT EXISTS "notification_schedules_user_index" ON "notification_schedules" ("user_id");
