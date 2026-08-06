CREATE TABLE IF NOT EXISTS "repository_lfs_locks" (
  "id" BIGSERIAL PRIMARY KEY,
  "repository_id" bigint not null REFERENCES "repositories"("id") ON DELETE CASCADE,
  "lock_id" varchar(64) not null,
  "path" text not null,
  "owner_id" integer not null,
  "owner_name" varchar(120) not null,
  "ref" varchar(255),
  "locked_at" varchar(64) not null,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS "repository_lfs_locks_repo_path_index" ON "repository_lfs_locks" ("repository_id", "path");
CREATE UNIQUE INDEX IF NOT EXISTS "repository_lfs_locks_lock_id_index" ON "repository_lfs_locks" ("lock_id");
CREATE UNIQUE INDEX IF NOT EXISTS "repository_lfs_locks_lock_id_unique" ON "repository_lfs_locks" ("lock_id");
