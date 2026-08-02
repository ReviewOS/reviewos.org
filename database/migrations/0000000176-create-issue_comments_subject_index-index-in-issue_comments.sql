CREATE INDEX IF NOT EXISTS "issue_comments_subject_index" ON "issue_comments" ("commentable_type", "commentable_id");
