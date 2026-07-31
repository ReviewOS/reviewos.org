CREATE TYPE "access_tokens_selection_type" AS ENUM ('all', 'organization', 'selected');
CREATE TYPE "access_token_permissions_scope_type" AS ENUM ('contents', 'issues', 'pull_requests', 'webhooks', 'administration', 'members', 'organization_administration', 'billing');
CREATE TYPE "access_token_permissions_level_type" AS ENUM ('read', 'write', 'admin');
