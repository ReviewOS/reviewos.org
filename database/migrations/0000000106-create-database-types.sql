DO $stacks$ BEGIN CREATE TYPE "notification_subscriptions_subject_type_type" AS ENUM ('issue', 'pull_request', 'repository');
EXCEPTION WHEN duplicate_object THEN null;
END $stacks$;
DO $stacks$ BEGIN CREATE TYPE "notification_subscriptions_reason_type" AS ENUM ('review_requested', 'assigned', 'mentioned', 'team_mention', 'author', 'participating', 'watching');
EXCEPTION WHEN duplicate_object THEN null;
END $stacks$;
DO $stacks$ BEGIN CREATE TYPE "webhooks_content_type_type" AS ENUM ('application/json', 'application/x-www-form-urlencoded');
EXCEPTION WHEN duplicate_object THEN null;
END $stacks$;
