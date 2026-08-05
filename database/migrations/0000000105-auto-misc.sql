DO $stacks$ BEGIN CREATE TYPE "timeline_entries_kind_type" AS ENUM ('closed', 'reopened', 'renamed', 'labeled', 'unlabeled', 'assigned', 'unassigned', 'milestoned', 'demilestoned', 'locked', 'unlocked', 'referenced', 'mentioned', 'merged');
EXCEPTION WHEN duplicate_object THEN null;
END $stacks$;
-- The guard above swallows the CREATE on any database that already has the
-- type, which is every database: migration 1 created it. So the new member has
-- to be asserted on its own, or `mentioned` never exists and every cross
-- reference insert fails against a column that will not take it.
--
-- Generated corpora carry this line themselves from the fix in
-- `guardPostgresEnumTypes` (stacks, `storage/framework/core/database`), which
-- now emits an ADD VALUE per member for exactly this reason. This app's
-- node_modules holds a published copy rather than a link to the local checkout,
-- so the generator that wrote this file predates the fix.
ALTER TYPE "timeline_entries_kind_type" ADD VALUE IF NOT EXISTS 'mentioned';
ALTER TABLE "timeline_entries" ALTER COLUMN "kind" DROP DEFAULT;
ALTER TABLE "timeline_entries" ALTER COLUMN "kind" TYPE "timeline_entries_kind_type" USING "kind"::"timeline_entries_kind_type";
ALTER TABLE "timeline_entries" ALTER COLUMN "kind" DROP NOT NULL;
