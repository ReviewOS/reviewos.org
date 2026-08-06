-- Drop the foreign keys the cascade ones replace.
--
-- Every one of these was created inline with the table, so Postgres named it
-- itself: `issues_repository_id_fkey`, not the `issues_repository_id_fk` the
-- migrations after this one add. Both would be held, and a server enforces
-- every constraint it holds - so the new ON DELETE CASCADE would be real and
-- deletes would go on failing against the NO ACTION beside it, with nothing in
-- the output saying so.
--
-- `releases` is the exception that forces this file to run first rather than
-- last: its constraint is already called `releases_repository_id_fk`, so the
-- ADD in 0000000130 collides with it by name rather than merely coexisting.
--
-- IF EXISTS throughout: a database created after the models declared their
-- cascade has none of these, and this file has to be a no-op there rather than
-- an error.

ALTER TABLE "access_token_repositories" DROP CONSTRAINT IF EXISTS "access_token_repositories_repository_id_fkey";
ALTER TABLE "attachments" DROP CONSTRAINT IF EXISTS "attachments_repository_id_fkey";
ALTER TABLE "check_runs" DROP CONSTRAINT IF EXISTS "check_runs_repository_id_fkey";
ALTER TABLE "issues" DROP CONSTRAINT IF EXISTS "issues_repository_id_fkey";
ALTER TABLE "milestones" DROP CONSTRAINT IF EXISTS "milestones_repository_id_fkey";
ALTER TABLE "protected_branches" DROP CONSTRAINT IF EXISTS "protected_branches_repository_id_fkey";
ALTER TABLE "pull_requests" DROP CONSTRAINT IF EXISTS "pull_requests_repository_id_fkey";
ALTER TABLE "releases" DROP CONSTRAINT IF EXISTS "releases_repository_id_fkey";
ALTER TABLE "releases" DROP CONSTRAINT IF EXISTS "releases_repository_id_fk";
ALTER TABLE "repo_collaborators" DROP CONSTRAINT IF EXISTS "repo_collaborators_repository_id_fkey";
ALTER TABLE "repo_topics" DROP CONSTRAINT IF EXISTS "repo_topics_repository_id_fkey";
ALTER TABLE "repository_labels" DROP CONSTRAINT IF EXISTS "repository_labels_repository_id_fkey";
ALTER TABLE "repository_mirrors" DROP CONSTRAINT IF EXISTS "repository_mirrors_repository_id_fkey";
ALTER TABLE "stars" DROP CONSTRAINT IF EXISTS "stars_repository_id_fkey";
ALTER TABLE "watches" DROP CONSTRAINT IF EXISTS "watches_repository_id_fkey";
ALTER TABLE "webhooks" DROP CONSTRAINT IF EXISTS "webhooks_repository_id_fkey";
