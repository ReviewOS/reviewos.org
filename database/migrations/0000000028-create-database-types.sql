CREATE TYPE "repositories_owner_type_type" AS ENUM ('user', 'organization');
CREATE TYPE "repositories_visibility_type" AS ENUM ('public', 'private', 'internal');
CREATE TYPE "watches_subscription_type" AS ENUM ('all', 'participating', 'ignore');
CREATE TYPE "repo_collaborators_permission_type" AS ENUM ('read', 'triage', 'write', 'maintain', 'admin');
