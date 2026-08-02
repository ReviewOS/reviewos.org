DO $stacks$ BEGIN CREATE TYPE "notification_mutes_subject_type_type" AS ENUM ('repository', 'organization', 'issue', 'pull_request');
EXCEPTION WHEN duplicate_object THEN null;
END $stacks$;
