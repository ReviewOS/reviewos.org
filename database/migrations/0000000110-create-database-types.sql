CREATE TYPE "check_runs_status_type" AS ENUM ('queued', 'in_progress', 'completed');
CREATE TYPE "check_runs_conclusion_type" AS ENUM ('success', 'failure', 'neutral', 'cancelled', 'timed_out', 'action_required', 'skipped', 'stale');
