ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "allow_merge_commit" boolean default true;
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "allow_squash_merge" boolean default true;
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "allow_rebase_merge" boolean default true;
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "default_merge_strategy" "repositories_default_merge_strategy_type" default 'merge';
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "delete_branch_on_merge" boolean default false;
