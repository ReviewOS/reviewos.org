# 09 - Checks and CI

Two separate things, in order. Accepting status from CI that already exists is small and useful.
Running other people's code is a security project, and it comes second, if at all.

## Commit status and checks API

- [ ] `app/Models/CommitStatus.ts`: `repository_id`, `sha`, `context`, `state` (pending, success,
      failure, error), `target_url`, `description`, `creator_id`
- [ ] `app/Models/CheckRun.ts`: richer than a status - `name`, `status` (queued, in_progress,
      completed), `conclusion` (success, failure, neutral, cancelled, timed_out, action_required),
      `started_at`, `completed_at`, `output_title`, `output_summary`, `annotations`
- [ ] `app/Actions/Checks/CreateStatusAction.ts`, `UpdateCheckRunAction.ts`
- [ ] Statuses roll up per commit, and per pull request head
- [ ] Required checks enforced by protected branches and the merge action
- [ ] Annotations render inline in the diff, on the lines they refer to. An annotation shown only in
      a log is a link nobody clicks.
- [ ] Checks tab on a pull request
- [ ] Tests: a required check that never reports blocks the merge, and reporting late unblocks it

This much makes ReviewOS usable with any existing CI. Ship it and stop, until there is a reason not
to.

## Runners, if they happen

Only with a considered answer to arbitrary code execution. The notes below are the decisions that
would have to be made, not a plan that is approved.

- [ ] Decide the isolation boundary first: container, VM, or refusing to host runners and supporting
      self-hosted ones only. This decides everything else.
- [ ] Workflow definition format. Reusing the GitHub Actions schema buys ecosystem compatibility and
      inherits its complexity and its security model.
- [ ] Runner registration, authentication, and scoping to a repository or organization
- [ ] Secrets: encrypted at rest, injected per job, redacted from logs, and never exposed to a job
      triggered by a fork's pull request
- [ ] Log streaming and retention
- [ ] Artifact storage and expiry
- [ ] Concurrency, queueing, and per-owner quotas, since without them one repository starves the
      instance
- [ ] A security review of the whole design before a single job runs

## Deployments

- [ ] `app/Models/Deployment.ts` and `DeploymentStatus.ts`, environments, and deployment history
- [ ] Environment protection rules, including required reviewers for a deploy
