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
import { repositoryPath } from '../Git/storage'
import { preparePlugins } from '../Plugin/prepare'
import { policyLevels } from '../Plugin/store'
import { setting } from '../../Ops/settings'
import { branchDecision, skipDecision } from './stepAttributes'
import type { Combination, MatrixAdjustment } from './matrix'
import { adjustmentFor } from './matrix'
import type { ConcurrencyContext } from './concurrency'
import { resolveGroup } from './concurrency'
import { globMatches } from './triggers'
import { shouldRun } from './expression'
import type { SubjectEventName } from './triggers'
import { subjectStartsRun } from './triggers'
import { callScope, MAX_CALL_DEPTH, resolveCall } from './reusable'
import type { PullRequestEvent, PushEvent } from './triggers'
import { pullRequestStartsRun, pushStartsRun } from './triggers'
import { repositoryDispatchStartsRun, workflowRunStartsRun } from './triggers'
import { forkApprovalFacts, forkApprovalVerdict } from './forkApproval'

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
      // Started by a program, and started by another workflow finishing. Both
      // were stored on every version and read by nothing.
      'workflow_versions.on_repository_dispatch as on_repository_dispatch',
      'workflow_versions.repository_dispatch_types as repository_dispatch_types',
      'workflow_versions.on_workflow_run as on_workflow_run',
      'workflow_versions.workflow_run_workflows as workflow_run_workflows',
      'workflow_versions.workflow_run_types as workflow_run_types',
      'workflow_versions.workflow_run_branches as workflow_run_branches',
      'workflow_versions.concurrency_group as concurrency_group',
      'workflow_versions.cancel_in_progress as cancel_in_progress',
      'workflow_versions.intermediate as intermediate',
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
  const row = await db
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

  const repository = await db
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
      const run = await db
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
      await supersede(input.repositoryId, runId, group, version.cancel_in_progress === true, String(version.intermediate ?? 'run'))
      await holdForGroup({
        repositoryId: input.repositoryId,
        runId,
        group,
        cancelInProgress: version.cancel_in_progress === true,
        intermediate: String(version.intermediate ?? 'run'),
      })

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

export interface RepositoryDispatchInput {
  repositoryId: number
  /** What the caller called it: `deploy-staging`, `dependency-updated`. */
  eventType: string
  /** Whatever the caller sent with it, verbatim, for `github.event.client_payload`. */
  clientPayload?: Record<string, unknown> | null
  actorId?: number | null
}

/**
 * Create the runs a `repository_dispatch` should start.
 *
 * The trigger for everything that happens somewhere else: an external
 * deployment pipeline saying it finished, a package index saying a dependency
 * moved, a nightly job on somebody's laptop. Actions has it, this instance
 * recorded it as recognised-but-inert, and a workflow that named it never ran.
 *
 * Recorded against the default branch and trusted, like the issue triggers: the
 * definition is the registered one and the caller supplied no code, only a
 * name and a payload.
 */
export async function dispatchRepositoryDispatch(input: RepositoryDispatchInput): Promise<DispatchResult> {
  const result: DispatchResult = { created: [], duplicates: 0, skipped: [] }

  const repository = await db
    .selectFrom('repositories')
    .select(['id', 'default_branch'])
    .where('id', '=', input.repositoryId)
    .executeTakeFirst()

  if (!repository)
    return result

  const versions = newestPerWorkflow(await currentVersions(input.repositoryId))
  const ref = `refs/heads/${repository.default_branch || 'main'}`
  const payload = input.clientPayload && typeof input.clientPayload === 'object' ? input.clientPayload : null

  for (const version of versions) {
    const decision = repositoryDispatchStartsRun(version, input.eventType)

    if (!decision.run) {
      if (!decision.reason.includes('does not trigger'))
        result.skipped.push({ versionId: Number(version.id), reason: decision.reason })

      continue
    }

    const sha = String(version.source_sha ?? '')

    const context: ConcurrencyContext = {
      workflow: String(version.workflow_name || version.workflow_path || ''),
      eventName: 'repository_dispatch',
      ref,
      sha,
    }

    const group = resolveGroup(version.concurrency_group, context)

    try {
      const run = await db
        .insertInto('workflow_runs')
        .values({
          workflow_version_id: Number(version.id),
          repository_id: input.repositoryId,
          number: await nextNumber(input.repositoryId),
          state: 'queued',
          event: 'repository_dispatch',
          /*
           * The event type and the clock in the ref.
           *
           * The redelivery index is on (version, ref, head, event), and a
           * program calling this twice for two different things means two runs
           * - the same call for the same thing twice usually does as well,
           * because a caller retrying is a caller that did not hear the first
           * answer.
           */
          event_ref: `${ref}#repository_dispatch/${input.eventType}/${Date.now()}`,
          head_sha: sha,
          definition_sha: sha,
          trusted: true,
          actor_id: input.actorId ?? null,
          concurrency_group: group,
          // Handed to the job as `github.event.client_payload`, which is the
          // whole reason a caller sends one.
          dispatch_inputs: payload ? JSON.stringify({ client_payload: payload, event_type: input.eventType }) : null,
        } as any)
        .returning(['id'])
        .executeTakeFirst()

      const runId = Number(run?.id)

      await createJobs(runId, Number(version.id), context)
      await supersede(input.repositoryId, runId, group, version.cancel_in_progress === true, String(version.intermediate ?? 'run'))
      await holdForGroup({
        repositoryId: input.repositoryId,
        runId,
        group,
        cancelInProgress: version.cancel_in_progress === true,
        intermediate: String(version.intermediate ?? 'run'),
      })

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

/**
 * Create the runs a finished run should start.
 *
 * `workflow_run` exists rather than being expressed with `needs:` because of
 * trust: the second workflow can be one a fork's pull request may not touch, so
 * a build produced by an untrusted run is published by something the fork could
 * not edit. That only holds if the second run is judged on its own terms, which
 * is why it is recorded **trusted** and against the default branch - it is the
 * repository's own workflow, started by this instance.
 *
 * **A `workflow_run` run does not start another one.** Actions bounds the same
 * loop with a depth limit; refusing outright is simpler to explain and there is
 * no honest use for the second hop that `needs:` does not already cover.
 */
export async function dispatchWorkflowRun(input: {
  runId: number
  /** `completed` or `requested`. */
  activity?: string
}): Promise<DispatchResult> {
  const result: DispatchResult = { created: [], duplicates: 0, skipped: [] }
  const activity = input.activity ?? 'completed'

  const finished = await db
    .selectFrom('workflow_runs')
    .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
    .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
    .select([
      'workflow_runs.id as id',
      'workflow_runs.repository_id as repository_id',
      'workflow_runs.event as event',
      'workflow_runs.event_ref as event_ref',
      'workflow_runs.number as number',
      'workflow_runs.state as state',
      'workflow_runs.conclusion_reason as conclusion_reason',
      'workflows.name as workflow_name',
      'workflows.path as workflow_path',
    ])
    .where('workflow_runs.id', '=', input.runId)
    .executeTakeFirst()

  if (!finished)
    return result

  if (String(finished.event) === 'workflow_run')
    return result

  const repository = await db
    .selectFrom('repositories')
    .select(['id', 'default_branch'])
    .where('id', '=', Number(finished.repository_id))
    .executeTakeFirst()

  if (!repository)
    return result

  const versions = newestPerWorkflow(await currentVersions(Number(finished.repository_id)))
  const ref = `refs/heads/${repository.default_branch || 'main'}`

  const triggering = {
    workflow: String(finished.workflow_name || finished.workflow_path || ''),
    activity,
    ref: String(finished.event_ref ?? ref).split('#')[0] ?? ref,
  }

  for (const version of versions) {
    const decision = workflowRunStartsRun(version, triggering)

    if (!decision.run) {
      if (!decision.reason.includes('does not trigger'))
        result.skipped.push({ versionId: Number(version.id), reason: decision.reason })

      continue
    }

    const sha = String(version.source_sha ?? '')

    const context: ConcurrencyContext = {
      workflow: String(version.workflow_name || version.workflow_path || ''),
      eventName: 'workflow_run',
      ref,
      sha,
    }

    const group = resolveGroup(version.concurrency_group, context)

    try {
      const run = await db
        .insertInto('workflow_runs')
        .values({
          workflow_version_id: Number(version.id),
          repository_id: Number(finished.repository_id),
          number: await nextNumber(Number(finished.repository_id)),
          state: 'queued',
          event: 'workflow_run',
          // The run that started this one, so two finishes of the same
          // workflow are two runs rather than one redelivered.
          event_ref: `${ref}#workflow_run/${finished.id}/${activity}`,
          head_sha: sha,
          definition_sha: sha,
          trusted: true,
          concurrency_group: group,
          dispatch_inputs: JSON.stringify({
            workflow_run: {
              id: Number(finished.id),
              name: triggering.workflow,
              run_number: Number(finished.number ?? 0),
              /*
               * The run's state is its conclusion here: there is no separate
               * column, and inventing one for this payload would be a second
               * answer to "how did it go" that could disagree with the first.
               */
              conclusion: String(finished.state ?? ''),
              event: String(finished.event ?? ''),
            },
          }),
        } as any)
        .returning(['id'])
        .executeTakeFirst()

      const runId = Number(run?.id)

      await createJobs(runId, Number(version.id), context)
      await supersede(Number(finished.repository_id), runId, group, version.cancel_in_progress === true, String(version.intermediate ?? 'run'))
      await holdForGroup({
        repositoryId: Number(finished.repository_id),
        runId,
        group,
        cancelInProgress: version.cancel_in_progress === true,
        intermediate: String(version.intermediate ?? 'run'),
      })

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
    changed: input.event.changed ?? [],
  }

  const group = resolveGroup(version.concurrency_group, context)

  /*
   * Whether a person has to say yes before this runs.
   *
   * The fork policy's last clause, enforced here because this is the only
   * dispatch path that can produce an untrusted run. A held run is `waiting`
   * rather than `queued`, which is what keeps it away from the claim: a machine
   * asking for work never sees it, so there is no second place to get this
   * right.
   */
  const trusted = target ? true : !input.event.fromFork
  const approval = forkApprovalVerdict(await forkApprovalFacts({
    repositoryId: input.repositoryId,
    actorId: input.actorId ?? null,
    trusted,
  }))

  try {
    const run = await db
      .insertInto('workflow_runs')
      .values({
        workflow_version_id: Number(version.id),
        repository_id: input.repositoryId,
        number: await nextNumber(input.repositoryId),
        state: approval.required ? 'waiting' : 'queued',
        approval_state: approval.required ? 'required' : 'not-required',
        conclusion_reason: approval.required ? approval.reason : null,
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
        trusted,
        actor_id: input.actorId ?? null,
        concurrency_group: group,
      } as any)
      .returning(['id'])
      .executeTakeFirst()

    const runId = Number(run?.id)
    await createJobs(runId, Number(version.id), context)

    /*
     * A held run's jobs are `blocked` with the reason on them, not `queued`.
     *
     * The run being `waiting` is what keeps a machine from taking them, so this
     * is about the person reading the screen: a list of queued jobs under a run
     * nothing will claim is somebody investigating their runners for an hour.
     */
    if (approval.required) {
      await db
        .updateTable('workflow_jobs')
        .set({ state: 'blocked', condition_reason: approval.reason } as any)
        .where('workflow_run_id', '=', runId)
        .where('state', '=', 'queued')
        .execute()
    }

    await supersede(input.repositoryId, runId, group, version.cancel_in_progress === true, String(version.intermediate ?? 'run'))
    await holdForGroup({
      repositoryId: input.repositoryId,
      runId,
      group,
      cancelInProgress: version.cancel_in_progress === true,
      intermediate: String(version.intermediate ?? 'run'),
    })

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
    // What the push touched, so a job can say which paths it cares about.
    changed: input.event.changed ?? [],
    // And what it said, which is the other half of what a per-job `if:` needs
    // and what `on:` filters cannot express at all.
    message: input.event.message ?? '',
  }

  const group = resolveGroup(version.concurrency_group, context)

  try {
    const run = await db
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
    await supersede(input.repositoryId, runId, group, version.cancel_in_progress === true, String(version.intermediate ?? 'run'))
    await holdForGroup({
      repositoryId: input.repositoryId,
      runId,
      group,
      cancelInProgress: version.cancel_in_progress === true,
      intermediate: String(version.intermediate ?? 'run'),
    })

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
 * The other half - queueing the newer run *behind* the older one when
 * `cancel-in-progress` is false - is `holdForGroup` below, released by the
 * settler when the run ahead finishes.
 */
async function supersede(
  repositoryId: number,
  runId: number,
  group: string | null,
  cancelInProgress: boolean,
  intermediate: string = 'run',
): Promise<void> {
  if (!group)
    return

  /*
   * `skip` and `cancel` differ in one thing: whether a build that has already
   * started is stopped.
   *
   * Three commits in a minute is the case both are for. `cancel` stops
   * whatever is running, which is right when only the newest result matters and
   * the machines are the scarce thing. `skip` lets the started build finish and
   * drops the ones that have not - which is what people usually mean, because
   * the run in progress will produce a result somebody can read while the
   * queued ones would produce two nobody will.
   */
  if (intermediate === 'skip') {
    const waiting = await db
      .selectFrom('workflow_runs')
      .select(['id'])
      .where('repository_id', '=', repositoryId)
      .where('concurrency_group', '=', group)
      .where('id', '!=', runId)
      // Not started: no runner has taken any of its jobs. A run that is
      // `running` is one somebody is already waiting on.
      .where('state', '=', 'queued')
      .execute()

    for (const run of waiting) {
      await db
        .updateTable('workflow_runs')
        .set({
          state: 'cancelled',
          finished_at: new Date().toISOString(),
          conclusion_reason: 'Skipped: a newer commit arrived before this run started.',
        } as any)
        .where('id', '=', Number(run.id))
        .where('state', '=', 'queued')
        .execute()

      await db
        .updateTable('workflow_jobs')
        .set({ state: 'cancelled', finished_at: new Date().toISOString() } as any)
        .where('workflow_run_id', '=', Number(run.id))
        .where('state', 'in', ['blocked', 'queued'])
        .execute()
    }

    return
  }

  if (!cancelInProgress && intermediate !== 'cancel')
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

/**
 * Hold this run behind the one already in its group.
 *
 * The `cancel-in-progress: false` half of `concurrency:`, and the half every
 * forge that ships the key seems to skip. Actions documents it - a second run
 * waits for the first - and a workflow that says `group: production` without
 * `cancel-in-progress` is a workflow asking for exactly one deploy at a time.
 * Running both anyway is not a smaller version of the feature; it is the
 * failure the key was written to prevent.
 *
 * `waiting` rather than `queued`, which is a state the run model already has
 * and nothing was using: the claim will not hand out the jobs of a run in it,
 * so the hold is one state change rather than a rule spread across every job.
 *
 * **Ordered by run id, not by which one asks first.** Two pushes a second apart
 * must land in the order they were pushed, and id order is push order; a queue
 * that released whichever run happened to be polled first would deploy the
 * older commit last.
 */
async function holdForGroup(input: {
  repositoryId: number
  runId: number
  group: string | null
  cancelInProgress: boolean
  intermediate: string
}): Promise<boolean> {
  // Only the plain case. `cancel` and `skip` have already decided what happens
  // to the runs around this one, and holding on top of either would be two
  // policies fighting over the same group.
  if (!input.group || input.cancelInProgress || input.intermediate !== 'run')
    return false

  const ahead = await db
    .selectFrom('workflow_runs')
    .select(['id'])
    .where('repository_id', '=', input.repositoryId)
    .where('concurrency_group', '=', input.group)
    .where('id', '<', input.runId)
    // Live: something that will still produce a result. A finished run holds
    // nothing back, and a cancelling one is on its way out.
    .where('state', 'in', ['queued', 'running', 'waiting', 'paused'])
    .orderBy('id')
    .executeTakeFirst()
    .catch(() => null)

  if (!ahead)
    return false

  await db
    .updateTable('workflow_runs')
    .set({
      state: 'waiting',
      // Said on the run, because "queued" with nothing happening for twenty
      // minutes is the most expensive screen in a forge. A reader should learn
      // that this is the concurrency key working, not a runner that is missing.
      conclusion_reason: `Waiting for run #${Number(ahead.id)} in concurrency group \`${input.group}\`.`,
    } as any)
    .where('id', '=', input.runId)
    .where('state', '=', 'queued')
    .execute()

  return true
}

/**
 * Let the next run in a group go, now that this one has finished.
 *
 * The release side of `holdForGroup`. Exported because the settler calls it,
 * and it lives here beside the hold: two halves of one rule in two files is how
 * one of them gets changed alone.
 *
 * One run per finish, the lowest id first. Releasing the whole group at once
 * would turn a serialized deploy queue into a stampede the first time two runs
 * piled up behind a slow one.
 */
export async function releaseGroup(repositoryId: number, group: string | null): Promise<number | null> {
  if (!group)
    return null

  const busy = await db
    .selectFrom('workflow_runs')
    .select(['id'])
    .where('repository_id', '=', repositoryId)
    .where('concurrency_group', '=', group)
    .where('state', 'in', ['queued', 'running', 'paused'])
    .executeTakeFirst()
    .catch(() => null)

  // Something in this group is still going. The release happens when *that*
  // one finishes, which is the guarantee the key is bought for.
  if (busy)
    return null

  const next = await db
    .selectFrom('workflow_runs')
    .select(['id'])
    .where('repository_id', '=', repositoryId)
    .where('concurrency_group', '=', group)
    .where('state', '=', 'waiting')
    .orderBy('id')
    .executeTakeFirst()
    .catch(() => null)

  if (!next)
    return null

  await db
    .updateTable('workflow_runs')
    .set({ state: 'queued', conclusion_reason: null } as any)
    .where('id', '=', Number(next.id))
    // Guarded on the state it was read at: two runs finishing at once must not
    // both release the same waiting run and hand its jobs out twice.
    .where('state', '=', 'waiting')
    .execute()

  return Number(next.id)
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

  /*
   * Settled once, immediately, because a run may have work to do before any
   * machine is involved.
   *
   * A barrier at the top of a graph is satisfied the moment the run exists, a
   * gate is waiting for a person from the first second, and a trigger has a run
   * to start. Waiting for the first claim to move the graph would leave a
   * run whose every job is the control plane's own sitting at `queued` with
   * nothing that could ever poll it.
   */
  const { settleRun } = await import('./settle')

  await settleRun(runId)
}

async function createJobs(
  runId: number,
  versionId: number,
  context?: ConcurrencyContext,
  call: { prefix?: string, depth?: number, trail?: number[], rootNeeds?: string[] } = {},
): Promise<void> {
  const definition = await db
    .selectFrom('workflow_version_jobs')
    .select([
      'job_id', 'name', 'position', 'runs_on', 'needs', 'matrix',
      'concurrency_group', 'job_cancel_in_progress', 'condition',
      'uses', 'call_with',
      // The policy the run is judged by, copied onto it below.
      'fail_fast', 'max_parallel', 'timeout_minutes', 'continue_on_error',
      // And what kind of job it is, which decides whether a runner ever sees it.
      'kind', 'settings', 'group_label', 'if_changed', 'priority',
    ])
    .where('workflow_version_id', '=', versionId)
    .orderBy('position')
    .execute()

  const depth = call.depth ?? 0
  const trail = call.trail ?? [versionId]
  const prefix = call.prefix ?? ''

  /*
   * What the *whole called workflow* waits for.
   *
   * A call job's `needs:` belongs to the caller's graph, and the jobs it
   * expands into are in the same run - so without grafting it onto the called
   * workflow's root jobs, a called workflow starts immediately however much the
   * caller said it should wait. Grafted onto roots only: a called job that
   * already needs something inside its own workflow is already downstream of
   * them.
   */
  const rootNeeds = call.rootNeeds ?? []

  let position = 0

  for (const job of definition) {
    const own = String(job.needs ?? '').trim()
    const needs = own || rootNeeds.join('\n')

    /*
     * A job that `uses:` another workflow has no steps of its own: what runs is
     * the called workflow's jobs, copied into this same run under the caller's
     * name. One run still shows everything that happened, which is what a
     * person reading a failed pipeline needs.
     */
    if (job.uses) {
      await expandCall({
        runId,
        repositoryId: await repositoryOf(runId),
        job,
        context,
        depth,
        trail,
        prefix,
        // What the call itself waits for, which the called workflow's root jobs
        // inherit - and which the call's own row waits for when the call cannot
        // be resolved.
        ownNeeds: needs.split('\n').map(one => one.trim()).filter(Boolean),
        position: position++,
      })

      continue
    }

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

      /*
       * `if-changed:`, decided here for the same reason `if:` is: a job that
       * is not going to run should say so from the moment the run exists,
       * rather than being queued and then quietly ignored.
       */
      const paths = pathDecision(job.if_changed, context?.changed ?? [])

      /*
       * `skip:` and `branches:` decide here rather than at claim time.
       *
       * Both are statements about whether this job should exist in this run at
       * all, and a job that will never run should read as skipped from the
       * first second - not sit in the queue looking like work nobody has got
       * to, which is how somebody ends up investigating a runner.
       */
      const attributes = settingsOfJob(job.settings)
      const skipped = skipDecision(attributes.skip)
      const branch = branchDecision(attributes.branches, String(context?.ref ?? ''))

      /*
       * And the adjustment for *this* combination, if the job singled one out.
       *
       * Decided here rather than at claim time for the same reason `skip:` is:
       * a combination that is not going to run should read as skipped from the
       * moment the run exists, with the reason on the row.
       */
      const adjusted = values ? adjustmentFor(values as Combination, attributes.adjustments) : null
      const adjustedSkip = skipDecision(adjusted?.skip ?? null)

      const runs = decision.run && paths.run && skipped.run && branch.run && adjustedSkip.run
      const why = !decision.run
        ? decision.reason
        : !paths.run
            ? paths.reason
            : !skipped.run
                ? skipped.reason
                : !branch.run ? branch.reason : adjustedSkip.reason

      /*
       * And one row per parallel copy of each of those.
       *
       * `parallelism: 5` is five jobs, for the same reason a matrix of four is
       * four: they are handed to five machines, they succeed and fail
       * separately, and a person looking at a failed run needs to see *which
       * shard* broke. The copies differ by one number, which the job spends on
       * deciding its own share of the work.
       *
       * A job with no `parallelism:` runs this loop once, so there is no branch
       * here and no second insert to keep in step with the first.
       */
      const copies = settingsOfJob(job.settings).parallelism

      /*
       * The job's plugins, resolved to commits and checked against the policy.
       *
       * A failure here makes the job `failed` from the moment the run exists,
       * with the reason on the row: a plugin that will never be permitted is
       * not a job to queue and let a machine discover.
       */
      const plugins = await pluginSettings({ runId, settings: job.settings })

      for (let copy = 0; copy < copies; copy++) {
        const created = await db
          .insertInto('workflow_jobs')
          .values({
            workflow_run_id: runId,
            // Prefixed when this job came from a called workflow, so two
            // workflows that both have a `build` are two rows rather than one
            // collision.
            job_id: prefix ? `${prefix}/${job.job_id}` : job.job_id,
            concurrency_group: group,
            condition: job.condition ?? null,
            condition_reason: !plugins.ok ? plugins.reason : runs ? (job.condition ? decision.reason : null) : why,
            // Actions' shape: `test (ubuntu-latest, 20)`. The values without
            // their keys, because that is what fits in a job list and what
            // somebody scanning a failed run already recognises.
            //
            // A parallel copy adds `(3/5)`, counting from one: the environment
            // hands the job a zero-based index because that is what the split
            // endpoint takes, and a person reading a run is not indexing an
            // array.
            name: shardName(
              callName(prefix, values ? `${job.name ?? job.job_id} (${labelFor(values)})` : (job.name ?? job.job_id)),
              copy,
              copies,
            ),
            parallel_index: copies > 1 ? copy : null,
            parallel_total: copies > 1 ? copies : null,
            position: position++,
            /*
             * `blocked` for everything the control plane resolves itself, even
             * with nothing to wait for.
             *
             * `queued` means "a runner may take this", and a gate that no runner
             * may take would sit in it forever. The settler moves them out on
             * the same pass that unblocks the rest of the graph.
             */
            state: !plugins.ok
              ? 'failed'
              : !runs
                  ? 'skipped'
                  : (needs.length > 0 || String(job.kind ?? 'command') !== 'command' ? 'blocked' : 'queued'),
            finished_at: plugins.ok ? null : new Date().toISOString(),
            needs,
            runs_on: job.runs_on,
            matrix_values: values ? JSON.stringify(values) : null,
            /*
             * Copied onto the run, like `needs` and `condition` above.
             *
             * These four decide what the run's outcome *means* - whether a
             * failure failed it, whether its siblings were stopped, how long it
             * was allowed to take - and reading them back from a definition that
             * has since been edited would make a finished run's conclusion
             * something nobody can reconstruct.
             */
            fail_fast: job.fail_fast !== false,
            max_parallel: job.max_parallel ?? null,
            timeout_minutes: job.timeout_minutes ?? null,
            /*
           * `soft-fail:` on an adjustment lands here, on this row only.
           *
           * Which is the whole point: `continue-on-error` is per job, so
           * tolerating the nightly Node version without it means tolerating
           * every version - and a matrix that tolerates everything is a matrix
           * that cannot fail a build.
           */
          continue_on_error: job.continue_on_error === true || adjusted?.softFail === true,
            kind: job.kind ?? 'command',
            settings: plugins.ok ? plugins.settings : (job.settings ?? null),
            group_label: job.group_label ?? null,
            priority: Number(job.priority ?? 0),
          } as any)
          .returning(['id'])
          .executeTakeFirst()

        await supersedeJobs(runId, Number(created?.id), group, job.job_cancel_in_progress === true)
      }
    }
  }
}

/** `test` with `(3/5)` after it, or `test` when there is only one of it. */
function shardName(name: string, index: number, total: number): string {
  return total > 1 ? `${name} (${index + 1}/${total})` : name
}

/**
 * Copy a called workflow's jobs into this run.
 *
 * A call that cannot be resolved becomes one `skipped` row carrying the reason,
 * rather than nothing at all: a run that silently misses half its pipeline is
 * the failure people spend an afternoon on, and the reason is the only thing
 * that can ever explain it.
 */
async function expandCall(input: {
  runId: number
  repositoryId: number
  job: any
  context?: ConcurrencyContext
  depth: number
  trail: number[]
  prefix: string
  ownNeeds?: string[]
  position?: number
}): Promise<void> {
  const { runId, repositoryId, job, context, depth, trail, prefix } = input
  const name = prefix ? `${prefix}/${job.job_id}` : String(job.job_id)
  const ownNeeds = input.ownNeeds ?? []

  const record = async (reason: string): Promise<void> => {
    await db
      .insertInto('workflow_jobs')
      .values({
        workflow_run_id: runId,
        job_id: name,
        name: callName(prefix, String(job.name ?? job.job_id)),
        position: 9000,
        state: 'skipped',
        needs: job.needs,
        runs_on: job.runs_on,
        condition_reason: reason,
      } as any)
      .execute()
  }

  if (depth >= MAX_CALL_DEPTH) {
    await record(`workflow calls are nested more than ${MAX_CALL_DEPTH} deep, which is where this stops following them`)
    return
  }

  /*
   * The scope an administrator set, read once per call rather than assumed.
   * Unreadable settings mean the narrow default, which is the safe direction:
   * a database this cannot read must not widen who may call what.
   */
  const scope = callScope(await setting('workflow_call_scope').catch(() => 'same-owner'))

  const resolved = await resolveCall(repositoryId, String(job.uses), parseWith(job.call_with), { scope })

  if (!resolved.ok || !resolved.target) {
    await record(resolved.error ?? 'this call could not be resolved')
    return
  }

  /*
   * A cycle is caught by the trail rather than by the depth limit, because the
   * limit would let one go round three times first - and three copies of a
   * pipeline is worse than none, since somebody has to work out which was
   * real.
   */
  if (trail.includes(resolved.target.versionId)) {
    await record(`\`${resolved.target.path}\` calls itself, directly or through another workflow`)
    return
  }

  await createJobs(runId, resolved.target.versionId, context, {
    prefix: name,
    depth: depth + 1,
    trail: [...trail, resolved.target.versionId],
    rootNeeds: ownNeeds,
  })

  /*
   * And a row for the call itself.
   *
   * Without one, `needs: [call]` in the caller named a job that was not in the
   * run: the graph read it as missing, the settler swept the dependent as
   * unreachable, and the run went **green having skipped the job after the
   * call**. A deploy behind a called build is exactly that shape, and nothing
   * about the run said so.
   *
   * A `wait` barrier, because that is what a call is once its jobs are in the
   * same run: it is finished when they are, it never reaches a machine, and its
   * outputs are the called workflow's declared outputs - resolved by the settler
   * when the barrier is released.
   */
  const called = await db
    .selectFrom('workflow_version_jobs')
    .select(['job_id', 'needs'])
    .where('workflow_version_id', '=', resolved.target.versionId)
    .execute()

  await db
    .insertInto('workflow_jobs')
    .values({
      workflow_run_id: runId,
      job_id: name,
      name: callName(prefix, String(job.name ?? job.job_id)),
      position: input.position ?? 8000,
      state: 'blocked',
      kind: 'wait',
      /*
       * Every job of the called workflow, not only its leaves.
       *
       * A leaf-only barrier would be released while a job the leaves did not
       * depend on was still running - which is ordinary in a called workflow
       * that does two independent things.
       */
      needs: called.map(row => `${name}/${row.job_id}`).join('\n'),
      runs_on: job.runs_on,
      // Where the outputs come from when this barrier is released.
      settings: JSON.stringify({ call: { versionId: resolved.target.versionId, prefix: name } }),
    } as any)
    .execute()
    .catch(() => null)
}

/** `deploy / build`, the way Actions names a called workflow's job. */
function callName(prefix: string, name: string): string {
  return prefix ? `${prefix} / ${name}` : name
}

/** The `with:` a call passes, from its stored JSON. */
function parseWith(stored: unknown): Record<string, unknown> {
  const text = String(stored ?? '').trim()

  if (!text)
    return {}

  try {
    const parsed = JSON.parse(text)

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  }
  catch {
    return {}
  }
}

/** The repository a run belongs to, for resolving a call against it. */
async function repositoryOf(runId: number): Promise<number> {
  const run = await db
    .selectFrom('workflow_runs')
    .select(['repository_id'])
    .where('id', '=', runId)
    .executeTakeFirst()

  return Number(run?.repository_id ?? 0)
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

  const run = await db
    .selectFrom('workflow_runs')
    .select(['repository_id'])
    .where('id', '=', runId)
    .executeTakeFirst()

  if (!run)
    return

  const siblings = await db
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
/**
 * The same builder, exported for the test that documents the set.
 *
 * A sandbox is only a sandbox if something checks its edges, and checking them
 * through a whole dispatch would mean a database for a question about a plain
 * object.
 */
export function conditionContextForTest(context: ConcurrencyContext, values: Record<string, unknown> | null): Record<string, unknown> {
  return conditionContext(context, values)
}

function conditionContext(context: ConcurrencyContext, values: Record<string, unknown> | null): Record<string, unknown> {
  const ref = context.ref ?? ''

  /*
   * The documented set a job's `if:` may read, and nothing else.
   *
   * Branch and tag, the trigger, the commit and its message, the changed
   * paths, the matrix combination and the declared inputs. Every one of them
   * is a fact about *this event* - an expression here cannot reach a step's
   * outcome (nothing has run yet, and `shouldRun` refuses rather than guesses)
   * and cannot reach the control plane at all.
   *
   * `ref_type` and the commit message were the two people reached for and did
   * not have: `if: github.ref_type == 'tag'` is how a release job is written,
   * and `contains(github.event.head_commit.message, '[skip ci]')` is the other
   * half of what `on:` filters cannot express per job.
   */
  return {
    github: {
      workflow: context.workflow ?? '',
      event_name: context.eventName ?? '',
      ref,
      ref_name: ref.replace(/^refs\/(?:heads|tags)\//, ''),
      ref_type: ref.startsWith('refs/tags/') ? 'tag' : ref.startsWith('refs/heads/') ? 'branch' : '',
      sha: context.sha ?? '',
      head_ref: context.headRef ?? '',
      base_ref: context.baseRef ?? '',
      event: {
        ...(context.number ? { number: context.number, pull_request: { number: context.number } } : {}),
        head_commit: { id: context.sha ?? '', message: context.message ?? '' },
      },
    },
    matrix: values ?? {},
    inputs: context.inputs ?? {},
    /*
     * `reviewos.changed` has no Actions equivalent, which is why it is under
     * this instance's own name rather than smuggled into `github`: a workflow
     * that reads it is one that would not run on GitHub, and a reader deserves
     * to see that in the expression rather than discover it on migration.
     */
    reviewos: { changed: [...(context.changed ?? [])] },
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

/**
 * Whether a job's `if-changed:` globs match what this event touched.
 *
 * **Unknown paths mean the job runs.** The changed list is empty when the
 * instance could not work out what moved - a force push, a first push, a
 * rewrite past the ceiling - and the two failures are not equal: a job that
 * runs when it need not have costs a machine for a few minutes, and a job that
 * is skipped when it should have run is a broken commit nobody noticed.
 */
/** A definition job's stored `reviewos:` attributes, which are JSON in a column. */
/**
 * The plugins a job asked for, resolved and checked, before the row exists.
 *
 * Returns the settings to store: the same object with `plugins` replaced by
 * what was resolved, or a reason the job cannot run. Checked here rather than
 * at the runner because the answer to "you misspelled `registry`" belongs on
 * the screen where somebody wrote it, and because a plugin the instance does
 * not permit should never be handed to a machine at all.
 *
 * The pool's half of the policy is not asked here: which pool a job runs in is
 * a fact about the runner that claims it, which does not exist yet.
 */
async function pluginSettings(input: {
  runId: number
  settings: unknown
}): Promise<{ ok: true, settings: string | null } | { ok: false, reason: string }> {
  const raw = String(input.settings ?? '')

  // The common case by a wide margin: no plugins, no repository read, no policy
  // query. Checked textually so a job without the key costs nothing.
  if (!raw.includes('"plugins"'))
    return { ok: true, settings: input.settings === null || input.settings === undefined ? null : raw }

  let parsed: any

  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return { ok: true, settings: raw }
  }

  const entries = Array.isArray(parsed?.plugins) ? parsed.plugins : []

  if (entries.length === 0)
    return { ok: true, settings: raw }

  const run = await db
    .selectFrom('workflow_runs')
    .innerJoin('repositories', 'repositories.id', '=', 'workflow_runs.repository_id')
    .select([
      'workflow_runs.head_sha as head_sha',
      'repositories.owner_type as owner_type',
      'repositories.owner_id as owner_id',
      'repositories.name as name',
    ])
    .where('workflow_runs.id', '=', input.runId)
    .executeTakeFirst()

  if (!run)
    return { ok: false, reason: 'this run has no repository to resolve plugins against' }

  const handle = await ownerHandle(String(run.owner_type), Number(run.owner_id))
  const located = handle ? repositoryPath(handle, String(run.name)) : { path: null as string | null }

  if (!located.path)
    return { ok: false, reason: 'this repository has no directory on this instance' }

  const prepared = await preparePlugins({
    entries: entries.map((entry: { reference?: unknown, parameters?: unknown }) => ({
      reference: String(entry?.reference ?? ''),
      parameters: (entry?.parameters ?? {}) as Record<string, unknown>,
    })),
    gitDir: located.path,
    sha: String(run.head_sha ?? ''),
    ownerType: String(run.owner_type),
    ownerId: Number(run.owner_id),
    policies: await policyLevels({ ownerType: String(run.owner_type), ownerId: Number(run.owner_id) }),
  })

  if (!prepared.ok)
    return { ok: false, reason: prepared.reason }

  return { ok: true, settings: JSON.stringify({ ...parsed, plugins: prepared.plugins }) }
}

/** A handle for an owner of either kind, which is what a repository path needs. */
async function ownerHandle(ownerType: string, ownerId: number): Promise<string | null> {
  const table = ownerType === 'organization' ? 'organizations' : 'users'

  const row = await db
    .selectFrom(table as any)
    .select(['handle'])
    .where('id', '=', ownerId)
    .executeTakeFirst()
    .catch(() => null)

  return row?.handle ? String(row.handle) : null
}

function settingsOfJob(settings: unknown): {
  skip: string | null
  branches: string[]
  parallelism: number
  adjustments: MatrixAdjustment[]
} {
  try {
    const parsed = JSON.parse(String(settings ?? '{}'))
    const parallelism = Number(parsed?.parallelism)

    return {
      skip: typeof parsed?.skip === 'string' ? parsed.skip : null,
      branches: Array.isArray(parsed?.branches) ? parsed.branches.map(String) : [],
      // One copy when the definition said nothing, which keeps the loop below
      // the same shape with and without the attribute.
      parallelism: Number.isInteger(parallelism) && parallelism > 0 ? parallelism : 1,
      adjustments: Array.isArray(parsed?.adjustments) ? parsed.adjustments : [],
    }
  }
  catch {
    return { skip: null, branches: [], parallelism: 1, adjustments: [] }
  }
}

function pathDecision(globs: unknown, changed: readonly string[]): { run: boolean, reason: string } {
  const patterns = String(globs ?? '').split('\n').map(line => line.trim()).filter(Boolean)

  if (patterns.length === 0)
    return { run: true, reason: '' }

  if (changed.length === 0)
    return { run: true, reason: '' }

  const matched = changed.some(path => patterns.some(pattern => globMatches(pattern, path)))

  return matched
    ? { run: true, reason: '' }
    : {
        run: false,
        // Named rather than "did not match": the whole value of skipping a job
        // in a monorepository is being able to see *why* it was skipped without
        // opening the file.
        reason: `Nothing this push changed matches ${patterns.map(pattern => `\`${pattern}\``).join(', ')}.`,
      }
}
