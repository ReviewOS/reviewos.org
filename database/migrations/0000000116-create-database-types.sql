DO $stacks$ BEGIN CREATE TYPE "access_tokens_selection_type" AS ENUM ('all', 'organization', 'selected');
EXCEPTION WHEN duplicate_object THEN null;
END $stacks$;
DO $stacks$ BEGIN CREATE TYPE "access_token_permissions_scope_type" AS ENUM ('contents', 'issues', 'pull_requests', 'webhooks', 'administration', 'members', 'organization_administration', 'billing');
EXCEPTION WHEN duplicate_object THEN null;
END $stacks$;
DO $stacks$ BEGIN CREATE TYPE "access_token_permissions_level_type" AS ENUM ('read', 'write', 'admin');
EXCEPTION WHEN duplicate_object THEN null;
END $stacks$;
