CREATE TABLE IF NOT EXISTS "repo_releases" (
  "id" BIGSERIAL PRIMARY KEY,
  "repository_id" integer not null REFERENCES "repositories"("id"),
  "user_id" integer REFERENCES "users"("id"),
  "tag_name" varchar(255) not null,
  "target_sha" varchar(40),
  "name" varchar(255),
  "body" text,
  "is_draft" boolean default false,
  "is_prerelease" boolean default false,
  "published_at" timestamp,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS "repo_releases_repo_tag_index" ON "repo_releases" ("repository_id", "tag_name");
CREATE INDEX IF NOT EXISTS "repo_releases_repo_published_index" ON "repo_releases" ("repository_id", "published_at");
