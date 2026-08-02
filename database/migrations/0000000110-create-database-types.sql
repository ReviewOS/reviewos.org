DO $stacks$ BEGIN CREATE TYPE "check_runs_status_type" AS ENUM ('queued', 'in_progress', 'completed');
EXCEPTION WHEN duplicate_object THEN null;
END $stacks$;
DO $stacks$ BEGIN CREATE TYPE "check_runs_conclusion_type" AS ENUM ('success', 'failure', 'neutral', 'cancelled', 'timed_out', 'action_required', 'skipped', 'stale');
EXCEPTION WHEN duplicate_object THEN null;
END $stacks$;
