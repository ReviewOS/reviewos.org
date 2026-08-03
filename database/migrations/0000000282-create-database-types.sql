DO $stacks$ BEGIN CREATE TYPE "timeline_entries_subject_type_type" AS ENUM ('issue', 'pull_request');
EXCEPTION WHEN duplicate_object THEN null;
END $stacks$;
DO $stacks$ BEGIN CREATE TYPE "timeline_entries_kind_type" AS ENUM ('closed', 'reopened', 'renamed', 'labeled', 'unlabeled', 'assigned', 'unassigned', 'milestoned', 'demilestoned', 'locked', 'unlocked', 'referenced', 'merged');
EXCEPTION WHEN duplicate_object THEN null;
END $stacks$;
