CREATE TABLE IF NOT EXISTS "taggable_models" (
  "id" BIGSERIAL PRIMARY KEY,
  "taggable_id" bigint not null,
  "tag_id" bigint not null REFERENCES "tags"("id"),
  "taggable_type" varchar(255) not null default 'posts',
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS "taggable_models_tag_id_taggable_id_taggable_type_unique" ON "taggable_models" ("tag_id", "taggable_id", "taggable_type");
