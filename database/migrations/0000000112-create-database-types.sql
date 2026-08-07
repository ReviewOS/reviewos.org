DO $stacks$ BEGIN CREATE TYPE "repositories_default_merge_strategy_type" AS ENUM ('merge', 'squash', 'rebase');
EXCEPTION WHEN duplicate_object THEN null;
END $stacks$;
ALTER TYPE "repositories_default_merge_strategy_type" ADD VALUE IF NOT EXISTS 'merge';
ALTER TYPE "repositories_default_merge_strategy_type" ADD VALUE IF NOT EXISTS 'squash';
ALTER TYPE "repositories_default_merge_strategy_type" ADD VALUE IF NOT EXISTS 'rebase';
