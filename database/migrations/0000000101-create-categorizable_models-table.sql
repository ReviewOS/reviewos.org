CREATE TABLE IF NOT EXISTS "categorizable_models" (
  "id" BIGSERIAL PRIMARY KEY,
  "category_id" bigint not null REFERENCES "categories"("id"),
  "categorizable_id" bigint not null,
  "categorizable_type" varchar(255) not null default 'posts',
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS "categorizable_models_category_id_categorizable_id_categorizable_type_unique" ON "categorizable_models" ("category_id", "categorizable_id", "categorizable_type");
