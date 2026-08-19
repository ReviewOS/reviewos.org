CREATE TABLE IF NOT EXISTS `access_token_repositories_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `access_token_repositories_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `activity_events_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `activity_events_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `attachments_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `attachments_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `audit_events_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `audit_events_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `check_annotations_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `check_annotations_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `check_runs_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `check_runs_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `commit_statuses_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `commit_statuses_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `coverage_files_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `coverage_files_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `deploy_keys_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `deploy_keys_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `deployments_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `deployments_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `environment_reviewers_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `environment_reviewers_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `environments_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `environments_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `git_wal_entries_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `git_wal_entries_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `issue_assignees_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `issue_assignees_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `issue_labels_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `issue_labels_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `issues_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `issues_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `managed_tests_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `managed_tests_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `merge_queue_entries_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `merge_queue_entries_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `milestones_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `milestones_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `protected_branches_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `protected_branches_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `pull_request_reviewers_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `pull_request_reviewers_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `pull_request_reviews_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `pull_request_reviews_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `pull_requests_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `pull_requests_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `release_assets_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `release_assets_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `releases_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `releases_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `repo_collaborators_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `repo_collaborators_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `repo_topics_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `repo_topics_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `repositories_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `repositories_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `repository_labels_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `repository_labels_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `repository_languages_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `repository_languages_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `repository_lfs_locks_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `repository_lfs_locks_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `repository_mirrors_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `repository_mirrors_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `review_checkpoints_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `review_checkpoints_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `review_drafts_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `review_drafts_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `review_threads_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `review_threads_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `reviewed_files_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `reviewed_files_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `run_metadata_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `run_metadata_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `runner_pool_repositories_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `runner_pool_repositories_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `stars_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `stars_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `team_repositories_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `team_repositories_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `test_monitors_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `test_monitors_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `test_runs_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `test_runs_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `test_suites_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `test_suites_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `watches_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `watches_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `webhook_deliveries_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `webhook_deliveries_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `webhooks_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `webhooks_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `workflow_artifacts_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `workflow_artifacts_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `workflow_jobs_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `workflow_jobs_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `workflow_notification_rules_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `workflow_notification_rules_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `workflow_runs_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `workflow_runs_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `workflow_versions_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `workflow_versions_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;

CREATE TABLE IF NOT EXISTS `workflows_seq` (
  `id` bigint NOT NULL,
  `next_id` bigint DEFAULT NULL,
  `cache` bigint DEFAULT NULL,
  PRIMARY KEY (`id`)
) COMMENT='vitess_sequence';
INSERT INTO `workflows_seq` (id, next_id, cache) VALUES (0, 1, 1000)
  ON DUPLICATE KEY UPDATE next_id = next_id;
