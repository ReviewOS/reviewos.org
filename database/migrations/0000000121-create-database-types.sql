DO $stacks$ BEGIN CREATE TYPE "repository_mirrors_direction_type" AS ENUM ('pull', 'push');
EXCEPTION WHEN duplicate_object THEN null;
END $stacks$;
DO $stacks$ BEGIN CREATE TYPE "repository_mirrors_provider_type" AS ENUM ('github', 'gitlab', 'git');
EXCEPTION WHEN duplicate_object THEN null;
END $stacks$;
