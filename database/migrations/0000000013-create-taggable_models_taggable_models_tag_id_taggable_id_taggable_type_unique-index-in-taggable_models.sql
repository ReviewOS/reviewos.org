CREATE UNIQUE INDEX IF NOT EXISTS "taggable_models_taggable_models_tag_id_taggable_id_taggable_type_unique" ON "taggable_models" ("tag_id", "taggable_id", "taggable_type");
