DO $stacks$ BEGIN CREATE TYPE "review_drafts_side_type" AS ENUM ('left', 'right');
EXCEPTION WHEN duplicate_object THEN null;
END $stacks$;
ALTER TYPE "review_drafts_side_type" ADD VALUE IF NOT EXISTS 'left';
ALTER TYPE "review_drafts_side_type" ADD VALUE IF NOT EXISTS 'right';
