/**
 * Turn a push into runs.
 *
 * Reads the versions a repository has, asks [the trigger
 * rules](./triggers.ts) which of them care, and writes a run and its jobs for
 * each. Nothing is executed and nothing is handed to a runner: the jobs land in
 * `blocked` or `queued`, and what picks them up is the execution plane, which
 * by [the threat model](../../../docs/ci-threat-model.md) is not this instance
 * unless an operator has provided one.
 *
 * **A redelivered event must not produce a second run.** The unique index on
 * (version, ref, head, event) is what enforces that, rather than a
 * check-then-insert: two deliveries arriving at once would both pass a check
 * and both insert. The insert is attempted and a collision is read as "somebody
 * else already made this run", which is the correct outcome either way.
 */

import { db } from '@stacksjs/database'
import type { PullRequestEvent, PushEvent } from './triggers'
import { pullRequestStartsRun, pushStartsRun } from './triggers'

export interface DispatchResult {
  /** Runs created by this delivery, not runs that exist. */
  created: number[]
  /** Versions that matched but already had a run for this push. */
  duplicates: number
  /** Why each version did not run, for the interface and for support. */
  skipped: Array<{ versionId: number, reason: string }>
}

/** The latest version of each active workflow in a repository. */
async function currentVersions(repositoryId: number): Promise<any[]> {
  return db
    .selectFrom('workflow_versions')
    // Four arguments, with the operator: the three-argument form this query
    // builder does not have fails at runtime rather than at typecheck.
    .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
    .select([
      'workflow_versions.id as id',
      'workflow_versions.workflow_id as workflow_id',
      'workflow_versions.on_push as on_push',
      'workflow_versions.push_branches as push_branches',
      // The negative filters travel with the positive ones: a version selected
      // without them is one whose `paths-ignore` silently does nothing, which
      // is the failure this product names Gitea for elsewhere.
      'workflow_versions.push_branches_ignore as push_branches_ignore',
      'workflow_versions.push_tags_ignore as push_tags_ignore',
      'workflow_versions.push_paths_ignore as push_paths_ignore',
      'workflow_versions.on_pull_request as on_pull_request',
      'workflow_versions.on_pull_request_target as on_pull_request_target',
      'workflow_versions.pull_request_branches as pull_request_branches',
      'workflow_versions.pull_request_paths as pull_request_paths',
      'workflow_versions.pull_request_branches_ignore as pull_request_branches_ignore',
      'workflow_versions.pull_request_paths_ignore as pull_request_paths_ignore',
      'workflow_versions.pull_request_types as pull_request_types',
      'workflow_versions.push_tags as push_tags',
      'workflow_versions.push_paths as push_paths',
      'workflow_versions.source_sha as source_sha',
    ])
    .where('workflows.repository_id', '=', repositoryId)
    .where('workflows.state', '=', 'active')
    // Newest first, then one per workflow below: a workflow edited twice in one
    // push has two versions and only the last one is current.
    .orderBy('workflow_versions.id', 'desc')
    .execute()
}

function newestPerWorkflow(rows: readonly any[]): any[] {
  const seen = new Set<number>()
  const newest: any[] = []

  for (const row of rows) {
    const workflowId = Number(row.workflow_id)
    if (seen.has(workflowId))
      continue

    seen.add(workflowId)
    newest.push(row)
  }

  return newest
}

/**
 * The next run number for a repository.
 *
 * Per repository rather than per workflow or per instance, because "run 42" is
 * how somebody refers to one out loud and a number that restarts per workflow
 * makes two runs called 42 in the same conversation.
 *
 * Read then written, which can collide under two simultaneous pushes. The
 * collision is not silent - the insert fails and the caller sees it - and the
 * alternative is a sequence per repository, which is a row nobody else needs.
 * Worth revisiting when runs are frequent enough for it to matter.
 */
async function nextNumber(repositoryId: number): Promise<number> {
  const row: any = await db
    .selectFrom('workflow_runs')
    .select(['number'])
    .where('repository_id', '=', repositoryId)
    .orderBy('number', 'desc')
    .limit(1)
    .executeTakeFirst()

  return Number(row?.number ?? 0) + 1
}

export interface DispatchInput {
  repositoryId: number
  event: PushEvent
  /** The commit the push left on the ref. */
  headSha: string
  /** Who pushed, when that is known. */
  actorId?: number | null
}

/**
 * Create the runs a push should start.
 *
 * Every version is considered and every refusal is returned rather than
 * dropped. A run that did not happen leaves nothing on screen, so the reason is
 * the only thing that can ever explain it.
 */
export async function dispatchPush(input: DispatchInput): Promise<DispatchResult> {
  const result: DispatchResult = { created: [], duplicates: 0, skipped: [] }

  const versions = newestPerWorkflow(await currentVersions(input.repositoryId))

  for (const version of versions) {
    const decision = pushStartsRun(version, input.event)

    if (!decision.run) {
      result.skipped.push({ versionId: Number(version.id), reason: decision.reason })
      continue
    }

    const created = await createRun(input, version)

    if (created === null)
      result.duplicates++
    else
      result.created.push(created)
  }

  return result
}

export interface PullRequestDispatchInput {
  repositoryId: number
  event: PullRequestEvent
  /** The pull request's head commit: the code that will be tested. */
  headSha: string
  /** The ref the run is recorded against, `refs/pull/12/head`. */
  ref: string
  /** Who opened or updated it, when that is known. */
  actorId?: number | null
}

/**
 * Create the runs a pull request event should start.
 *
 * **The definition comes from the base branch, never from the head.** That is
 * the first line of the fork policy in the threat model, and it is not a
 * precaution: a pull request that supplied its own workflow could write one
 * that prints the instance's secrets, and every other control in this codebase
 * would be decoration. `currentVersions` reads what the repository has, which
 * is what the base branch's last push registered - the head's own files are
 * never parsed into a version by this path.
 *
 * A run from a fork is recorded `trusted: false` and stays that way for its
 * whole life. Elevating one is a separate, human, per-run act; approximating it
 * here would be the same mistake in a smaller font.
 */
export async function dispatchPullRequest(input: PullRequestDispatchInput): Promise<DispatchResult> {
  const result: DispatchResult = { created: [], duplicates: 0, skipped: [] }

  const versions = newestPerWorkflow(await currentVersions(input.repositoryId))

  for (const version of versions) {
    /*
     * `pull_request` and `pull_request_target` are asked separately, because
     * they are the same event with the opposite trust. A workflow that names
     * both gets two runs, which is what Actions does and what a reader of the
     * run list needs to see: one of them may touch secrets and one may not.
     */
    for (const target of [false, true]) {
      const decision = pullRequestStartsRun(version, input.event, { target })

      if (!decision.run) {
        // Only the form the workflow actually asked for is worth reporting.
        // "does not trigger on pull_request_target" for every workflow in the
        // repository is noise that buries the one real reason.
        if (!decision.reason.includes('does not trigger'))
          result.skipped.push({ versionId: Number(version.id), reason: decision.reason })

        continue
      }

      const created = await createPullRequestRun(input, version, target)

      if (created === null)
        result.duplicates++
      else
        result.created.push(created)
    }
  }

  return result
}

/** One pull request run, or null when this delivery already produced it. */
async function createPullRequestRun(
  input: PullRequestDispatchInput,
  version: any,
  target: boolean,
): Promise<number | null> {
  try {
    const run: any = await db
      .insertInto('workflow_runs')
      .values({
        workflow_version_id: Number(version.id),
        repository_id: input.repositoryId,
        number: await nextNumber(input.repositoryId),
        state: 'queued',
        event: target ? 'pull_request_target' : 'pull_request',
        event_ref: input.ref,
        head_sha: input.headSha,
        /*
         * The two commits, kept apart.
         *
         * For a push they are the same. For a pull request they are not: the
         * head is the code under test and `definition_sha` is the commit the
         * workflow came from, which is on the base branch. A reader has to be
         * able to see which commit supplied the instructions.
         */
        definition_sha: String(version.source_sha ?? input.headSha),
        /*
         * A fork's pull request is untrusted for its whole life. Its own
         * branch, from somebody with write access, is not - the code and the
         * workflow are both from this repository.
         *
         * `pull_request_target` is the exception that makes the rule: it runs
         * the base branch's workflow, so it is trusted in the sense that
         * matters here, and it is exactly the trigger behind the published
         * secret-theft write-ups. It is marked trusted because it is, and what
         * protects the instance is that secrets are scoped per environment and
         * job rather than handed to a run for existing.
         */
        trusted: target ? true : !input.event.fromFork,
        actor_id: input.actorId ?? null,
      } as any)
      .returning(['id'])
      .executeTakeFirst()

    const runId = Number(run?.id)
    await createJobs(runId, Number(version.id))

    return runId
  }
  catch (error) {
    if (isDuplicate(error))
      return null

    throw error
  }
}

/**
 * One run, or null when this delivery has already produced it.
 *
 * A push to the repository's own branch is trusted: the code and the workflow
 * are both from the repository, and whoever pushed has write access. A fork's
 * pull request is a different path and is not this one - it is untrusted, and
 * it is deliberately not implemented here rather than approximated.
 */
async function createRun(input: DispatchInput, version: any): Promise<number | null> {
  try {
    const run: any = await db
      .insertInto('workflow_runs')
      .values({
        workflow_version_id: Number(version.id),
        repository_id: input.repositoryId,
        number: await nextNumber(input.repositoryId),
        state: 'queued',
        event: 'push',
        event_ref: input.event.ref,
        head_sha: input.headSha,
        // For a push these are the same commit. They are stored separately
        // because for a fork's pull request they are not, and a reader must be
        // able to see which commit supplied the workflow.
        definition_sha: String(version.source_sha ?? input.headSha),
        trusted: true,
        actor_id: input.actorId ?? null,
      } as any)
      .returning(['id'])
      .executeTakeFirst()

    const runId = Number(run?.id)
    await createJobs(runId, Number(version.id))

    return runId
  }
  catch (error) {
    // The unique index did its job: this push already has a run for this
    // version. Any other failure is not a duplicate and is worth raising.
    if (isDuplicate(error))
      return null

    throw error
  }
}

/** Postgres says 23505 for a unique violation; drivers wrap it differently. */
function isDuplicate(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message}` : String(error)
  return text.includes('23505') || text.toLowerCase().includes('duplicate key')
}

/**
 * The run's jobs, copied from the definition.
 *
 * Copied rather than referenced, because the run has to stay readable when the
 * definition changes - and because a job's state belongs to the run, not to the
 * workflow. A job with no `needs` is queued immediately; the rest wait.
 */
async function createJobs(runId: number, versionId: number): Promise<void> {
  const definition: any[] = await db
    .selectFrom('workflow_version_jobs')
    .select(['job_id', 'name', 'position', 'runs_on', 'needs'])
    .where('workflow_version_id', '=', versionId)
    .orderBy('position')
    .execute()

  for (const job of definition) {
    const needs = String(job.needs ?? '').trim()

    await db
      .insertInto('workflow_jobs')
      .values({
        workflow_run_id: runId,
        job_id: job.job_id,
        name: job.name,
        position: Number(job.position ?? 0),
        state: needs.length > 0 ? 'blocked' : 'queued',
        needs: job.needs,
        runs_on: job.runs_on,
      } as any)
      .execute()
  }
}
