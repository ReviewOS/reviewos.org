DO $stacks$ BEGIN CREATE TYPE "reactions_subject_type_type" AS ENUM ('issue', 'issue_comment', 'review_comment');
EXCEPTION WHEN duplicate_object THEN null;
END $stacks$;
DO $stacks$ BEGIN CREATE TYPE "reactions_content_type" AS ENUM ('+1', '-1', 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes');
EXCEPTION WHEN duplicate_object THEN null;
END $stacks$;
