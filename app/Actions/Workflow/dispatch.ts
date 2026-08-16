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
 *
 * That index deliberately excludes `workflow_dispatch`. A manual run is not a
 * delivery - there is nothing to have arrived twice - and somebody pressing
 * "run workflow" a second time means a second run.
 */

import { db } from '@stacksjs/database'
import type { ConcurrencyContext } from './concurrency'
import { resolveGroup } from './concurrency'
import { shouldRun } from './expression'
import type { SubjectEventName } from './triggers'
import { subjectStartsRun } from './triggers'
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
      'workflow_versions.on_issues as on_issues',
      'workflow_versions.issue_types as issue_types',
      'workflow_versions.on_issue_comment as on_issue_comment',
      'workflow_versions.issue_comment_types as issue_comment_types',
      'workflow_versions.on_release as on_release',
      'workflow_versions.release_types as release_types',
      'workflow_versions.concurrency_group as concurrency_group',
      'workflow_versions.cancel_in_progress as cancel_in_progress',
      // The workflow's name, for `${{ github.workflow }}` in a group.
      'workflows.name as workflow_name',
      'workflows.path as workflow_path',
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

export interface SubjectDispatchInput {
  repositoryId: number
  /** `issues`, `issue_comment` or `release`. */
  event: SubjectEventName
  /** `opened`, `created`, `published`, ... */
  activity: string
  /** The subject's number or tag, for the ref this run is recorded against. */
  subject: string
  /** Who did it, when that is known. */
  actorId?: number | null
}

/**
 * Create the runs an issue, comment or release should start.
 *
 * These are the two things people automate first - label a new issue, publish
 * on a release - and this instance already emitted the events for years of
 * roadmap before anything read them for CI.
 *
 * Runs are recorded against the repository's default branch, and the workflow
 * is the registered one: nothing about an issue is a tree, so there is no
 * question of which commit supplied the definition. That also means these runs
 * are trusted - the code and the workflow are both the repository's own.
 */
export async function dispatchSubject(input: SubjectDispatchInput): Promise<DispatchResult> {
  const result: DispatchResult = { created: [], duplicates: 0, skipped: [] }

  const repository: any = await db
    .selectFrom('repositories')
    .select(['id', 'default_branch'])
    .where('id', '=', input.repositoryId)
    .executeTakeFirst()

  if (!repository)
    return result

  const versions = newestPerWorkflow(await currentVersions(input.repositoryId))
  const ref = `refs/heads/${repository.default_branch || 'main'}`

  for (const version of versions) {
    const decision = subjectStartsRun(version, input.event, input.activity)

    if (!decision.run) {
      if (!decision.reason.includes('does not trigger'))
        result.skipped.push({ versionId: Number(version.id), reason: decision.reason })

      continue
    }

    const sha = String(version.source_sha ?? '')

    const context: ConcurrencyContext = {
      workflow: String(version.workflow_name || version.workflow_path || ''),
      eventName: input.event,
      ref,
      sha,
    }

    const group = resolveGroup(version.concurrency_group, context)

    try {
      const run: any = await db
        .insertInto('workflow_runs')
        .values({
          workflow_version_id: Number(version.id),
          repository_id: input.repositoryId,
          number: await nextNumber(input.repositoryId),
          state: 'queued',
          event: input.event,
          /*
           * The subject in the ref, so two issues do not look like one run
           * redelivered. The redelivery index is on (version, ref, head,
           * event), and every issue event in a repository shares a head.
           */
          event_ref: `${ref}#${input.event}/${input.subject}/${input.activity}`,
          head_sha: sha,
          definition_sha: sha,
          trusted: true,
          actor_id: input.actorId ?? null,
          concurrency_group: group,
        } as any)
        .returning(['id'])
        .executeTakeFirst()

      const runId = Number(run?.id)
      await createJobs(runId, Number(version.id), context)
      await supersede(input.repositoryId, runId, group, version.cancel_in_progress === true)

      result.created.push(runId)
    }
    catch (error) {
      if (isDuplicate(error))
        result.duplicates++
      else
        throw error
    }
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
  /** The pull request's number, for a concurrency group that names it. */
  number?: number | null
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
  const context: ConcurrencyContext = {
    workflow: String(version.workflow_name || version.workflow_path || ''),
    eventName: target ? 'pull_request_target' : 'pull_request',
    ref: input.ref,
    sha: input.headSha,
    headRef: input.event.headBranch ?? '',
    baseRef: input.event.baseBranch,
    number: input.number ?? null,
  }

  const group = resolveGroup(version.concurrency_group, context)

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
        concurrency_group: group,
      } as any)
      .returning(['id'])
      .executeTakeFirst()

    const runId = Number(run?.id)
    await createJobs(runId, Number(version.id), context)
    await supersede(input.repositoryId, runId, group, version.cancel_in_progress === true)

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
  const context: ConcurrencyContext = {
    workflow: String(version.workflow_name || version.workflow_path || ''),
    eventName: 'push',
    ref: input.event.ref,
    sha: input.headSha,
  }

  const group = resolveGroup(version.concurrency_group, context)

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
        concurrency_group: group,
      } as any)
      .returning(['id'])
      .executeTakeFirst()

    const runId = Number(run?.id)
    await createJobs(runId, Number(version.id), context)
    await supersede(input.repositoryId, runId, group, version.cancel_in_progress === true)

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

/**
 * Stop the runs this one replaces.
 *
 * Only when the workflow asked for it: Actions' default is that a second run
 * queues behind the first rather than replacing it, and cancelling by default
 * would throw away work somebody is watching. Turning it on is what makes a
 * branch's pipeline stop spending runners on commits nobody is waiting for.
 *
 * `cancelling` rather than `cancelled`, because a run that has been handed to
 * a runner has to be told, and the runner has to acknowledge - see phase 9. A
 * run nothing has picked up is moved on by the execution plane in the same
 * sweep; writing `cancelled` here would mean the control plane claiming an
 * outcome it cannot yet observe.
 *
 * Queueing the newer run behind the older one - the `cancel-in-progress: false`
 * half - is deliberately not done here. It is not a state a run can enter on
 * its own: something has to release the group when the first finishes, and that
 * something is the execution plane.
 */
async function supersede(
  repositoryId: number,
  runId: number,
  group: string | null,
  cancelInProgress: boolean,
): Promise<void> {
  if (!group || !cancelInProgress)
    return

  await db
    .updateTable('workflow_runs')
    .set({ state: 'cancelling' } as any)
    .where('repository_id', '=', repositoryId)
    .where('concurrency_group', '=', group)
    .where('id', '!=', runId)
    // Only what is still live. A finished run is history and a run already
    // being cancelled does not need telling twice.
    .where('state', 'in', ['queued', 'running', 'waiting', 'paused'])
    .execute()
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
export async function createJobsForRun(
  runId: number,
  versionId: number,
  context?: ConcurrencyContext,
): Promise<void> {
  await createJobs(runId, versionId, context)
}

async function createJobs(runId: number, versionId: number, context?: ConcurrencyContext): Promise<void> {
  const definition: any[] = await db
    .selectFrom('workflow_version_jobs')
    .select([
      'job_id', 'name', 'position', 'runs_on', 'needs', 'matrix',
      'concurrency_group', 'job_cancel_in_progress', 'condition',
    ])
    .where('workflow_version_id', '=', versionId)
    .orderBy('position')
    .execute()

  let position = 0

  for (const job of definition) {
    const needs = String(job.needs ?? '').trim()

    /*
     * One row per matrix combination.
     *
     * A matrix of four is four jobs in the run, not one job that somehow ran
     * four times: they succeed and fail separately, they are handed to
     * different runners, and a person looking at a failed run needs to see
     * *which* combination broke. The expansion happened at parse time and was
     * stored on the version - see `Workflow/matrix.ts` for why the order and
     * the include rules are not obvious.
     */
    for (const values of combinationsOf(job.matrix)) {
      /*
       * A job's own concurrency group, resolved against this run *and this
       * combination*.
       *
       * `matrix.node` is available in the expression, which matters: a matrix
       * job whose group names none of its matrix values puts every combination
       * in one group, and under `cancel-in-progress` they cancel each other.
       * Actions behaves the same way, and it is the shape people file bugs
       * about, so the values are offered rather than withheld.
       */
      const group = context
        ? resolveGroup(job.concurrency_group, withMatrix(context, values))
        : null

      /*
       * `if:` decided here rather than left to the execution plane.
       *
       * A job whose condition is false is `skipped` from the moment the run
       * exists, which is what a reader needs to see: a run that shows three
       * queued jobs and only ever runs one is a run nobody can plan around.
       *
       * Only what this side actually knows goes into the context - the event,
       * the ref, the commit, the matrix combination. A condition that reads
       * something else (a step's outcome, a job's status) cannot be answered
       * before anything has run, and `shouldRun` refuses rather than guesses,
       * so the job is skipped with the reason recorded. That is the safe
       * direction: the other one runs a deployment because a condition could
       * not be read.
       */
      const decision = context
        ? shouldRun(job.condition, conditionContext(context, values))
        : { run: true, reason: 'no condition context' }

      const created: any = await db
        .insertInto('workflow_jobs')
        .values({
          workflow_run_id: runId,
          job_id: job.job_id,
          concurrency_group: group,
          condition: job.condition ?? null,
          condition_reason: job.condition ? decision.reason : null,
          // Actions' shape: `test (ubuntu-latest, 20)`. The values without
          // their keys, because that is what fits in a job list and what
          // somebody scanning a failed run already recognises.
          name: values ? `${job.name ?? job.job_id} (${labelFor(values)})` : job.name,
          position: position++,
          state: !decision.run
            ? 'skipped'
            : (needs.length > 0 ? 'blocked' : 'queued'),
          needs: job.needs,
          runs_on: job.runs_on,
          matrix_values: values ? JSON.stringify(values) : null,
        } as any)
        .returning(['id'])
        .executeTakeFirst()

      await supersedeJobs(runId, Number(created?.id), group, job.job_cancel_in_progress === true)
    }
  }
}

/**
 * Stop the jobs this one replaces.
 *
 * The job-level twin of `supersede`, and it exists because the workflow level
 * cannot express the case people actually have: a workflow whose runs may
 * overlap, with one deployment job inside it that must not. Only when the job
 * asked for it, for the same reason - cancelling by default would throw away
 * work somebody is watching.
 *
 * Scoped to the repository through the run, so two repositories that happen to
 * write the same group string never touch each other's jobs.
 */
async function supersedeJobs(
  runId: number,
  jobId: number,
  group: string | null,
  cancelInProgress: boolean,
): Promise<void> {
  if (!group || !cancelInProgress || !jobId)
    return

  const run: any = await db
    .selectFrom('workflow_runs')
    .select(['repository_id'])
    .where('id', '=', runId)
    .executeTakeFirst()

  if (!run)
    return

  const siblings: any[] = await db
    .selectFrom('workflow_jobs')
    .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
    .select(['workflow_jobs.id as id'])
    .where('workflow_runs.repository_id', '=', Number(run.repository_id))
    .where('workflow_jobs.concurrency_group', '=', group)
    .where('workflow_jobs.id', '!=', jobId)
    // Only what is still live: a finished job is history, and one already being
    // cancelled does not need telling twice.
    .where('workflow_jobs.state', 'in', ['queued', 'blocked', 'running'])
    .execute()

  for (const sibling of siblings) {
    await db
      .updateTable('workflow_jobs')
      .set({ state: 'cancelling' } as any)
      .where('id', '=', Number(sibling.id))
      .execute()
  }
}

/**
 * The facts a job's `if:` may read before anything has run.
 *
 * Deliberately small. `steps` and `needs` do not exist yet, and `job.status`
 * is not a thing until a runner reports one - a condition asking for them is
 * refused by `shouldRun` rather than answered with an invented value.
 */
function conditionContext(context: ConcurrencyContext, values: Record<string, unknown> | null): Record<string, unknown> {
  const ref = context.ref ?? ''

  return {
    github: {
      workflow: context.workflow ?? '',
      event_name: context.eventName ?? '',
      ref,
      ref_name: ref.replace(/^refs\/(?:heads|tags)\//, ''),
      sha: context.sha ?? '',
      head_ref: context.headRef ?? '',
      base_ref: context.baseRef ?? '',
      event: context.number ? { number: context.number, pull_request: { number: context.number } } : {},
    },
    matrix: values ?? {},
  }
}

/** The run's context, with this combination's values available to an expression. */
function withMatrix(context: ConcurrencyContext, values: Record<string, unknown> | null): ConcurrencyContext {
  return values ? { ...context, matrix: values } : context
}

/**
 * The combinations a stored matrix describes, or a single `null` for no matrix.
 *
 * `null` rather than an empty list so the caller writes one row for a job with
 * no matrix without a branch: the loop is the same shape either way.
 */
function combinationsOf(stored: unknown): Array<Record<string, unknown> | null> {
  const text = String(stored ?? '').trim()

  if (!text)
    return [null]

  try {
    const parsed = JSON.parse(text)

    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [null]
  }
  catch {
    // A version whose matrix cannot be read still runs, once. Refusing would
    // turn a storage problem into a repository with no CI.
    return [null]
  }
}

/** `ubuntu-latest, 20`, the way Actions writes a matrix job's name. */
function labelFor(values: Record<string, unknown>): string {
  return Object.values(values)
    .map(value => (value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value)))
    .join(', ')
}
