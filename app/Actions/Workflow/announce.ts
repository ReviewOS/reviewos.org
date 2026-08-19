/**
 * Telling programs what a run is doing.
 *
 * A run is the longest-lived thing this product has: minutes, sometimes hours,
 * on machines the control plane does not own. Everything downstream of one - a
 * deployment gate, a dashboard, a merge queue, an agent waiting for its own
 * check - has exactly two ways to find out where it got to, and polling every
 * run every few seconds is the bad one.
 *
 * Two events, `run:transitioned` and `job:transitioned`, with the new state in
 * `action`. One event per transition rather than one per state, for the reason
 * `check:reported` is shaped that way: a receiver that only wants finished runs
 * reads one field, and a receiver that wants to know work *started* would
 * otherwise be waiting on an event that does not exist.
 *
 * **Never throws, and never awaited for its effect.** A webhook is a
 * consequence of the run moving and must not be able to fail the report, the
 * claim or the sweep that moved it. Emitted after the write, always: a receiver
 * that reads the run back the moment it hears must see what it was told.
 */

import { db } from '@stacksjs/database'
import { notifyProgramsOnly } from '../../Notifications/emit'

export interface RunFacts {
  id: number
  number: number
  state: string
  event?: string | null
  headSha?: string | null
  ref?: string | null
  workflowName?: string | null
}

export interface JobFacts {
  id: number
  jobId: string
  name?: string | null
  state: string
  runNumber: number
  runId: number
  runnerId?: string | null
}

/**
 * The owner handle and repository name, for the envelope.
 *
 * A query rather than a parameter because the callers are a sweep, a claim and
 * a report, and none of them has a reason to know either - threading them
 * through five layers to save a lookup on a path that has just written several
 * rows is the wrong trade. Read once per announcement, not per webhook.
 */
async function identify(repositoryId: number): Promise<{ owner: string, repository: string } | null> {
  const repository = await db
    .selectFrom('repositories')
    .select(['name', 'owner_type', 'owner_id'])
    .where('id', '=', repositoryId)
    .executeTakeFirst()

  if (!repository)
    return null

  const owner: any = String(repository.owner_type) === 'user'
    ? await db.selectFrom('users').select(['handle']).where('id', '=', Number(repository.owner_id)).executeTakeFirst()
    : await db.selectFrom('organizations').select(['handle']).where('id', '=', Number(repository.owner_id)).executeTakeFirst()

  return { owner: String(owner?.handle ?? ''), repository: String(repository.name ?? '') }
}

/** A run moved. */
export async function announceRun(repositoryId: number, run: RunFacts): Promise<void> {
  try {
    const named = await identify(repositoryId)
    if (!named)
      return

    await notifyProgramsOnly('run:transitioned', {
      // Nobody clicked. Zero reads as "the system" to every consumer, and a
      // sweep attributing itself to the last person who touched the run would
      // be worse than saying nothing.
      actorId: 0,
      actorHandle: '',
      repositoryId,
      owner: named.owner,
      repository: named.repository,
      // The repository, not a fourth `subject.type` for a receiver to learn.
      // The run is in `run`, where anything that cares is already looking.
      subjectType: 'repository',
      subjectId: repositoryId,
      title: `Run ${run.number} is ${run.state}`,
      run: {
        id: run.id,
        number: run.number,
        state: run.state,
        event: run.event ? String(run.event) : null,
        head_sha: run.headSha ? String(run.headSha) : null,
        ref: run.ref ? String(run.ref) : null,
        workflow: run.workflowName ? String(run.workflowName) : null,
      },
    })
  }
  catch (error) {
    console.error('[workflow] could not announce a run transition:', error)
  }
}

/** One job of a run moved. */
export async function announceJob(repositoryId: number, job: JobFacts): Promise<void> {
  try {
    const named = await identify(repositoryId)
    if (!named)
      return

    await notifyProgramsOnly('job:transitioned', {
      actorId: 0,
      actorHandle: '',
      repositoryId,
      owner: named.owner,
      repository: named.repository,
      subjectType: 'repository',
      subjectId: repositoryId,
      title: `${job.name ?? job.jobId} is ${job.state}`,
      job: {
        id: job.id,
        job_id: job.jobId,
        name: job.name ? String(job.name) : String(job.jobId),
        state: job.state,
        run_id: job.runId,
        run_number: job.runNumber,
        // Which machine, when one holds it. A fleet operator correlating a
        // slow job with a sick runner has no other way to join the two.
        runner: job.runnerId ? String(job.runnerId) : null,
      },
    })
  }
  catch (error) {
    console.error('[workflow] could not announce a job transition:', error)
  }
}

/**
 * Announce a run's state after a settle, when it actually changed.
 *
 * The guard is the point: `settleRun` recomputes the state on every report, and
 * most reports leave it where it was - a run with six jobs is `running` for all
 * six. Emitting each time would send five events saying nothing happened, and a
 * receiver cannot tell those from the one that matters.
 */
export async function announceRunIfMoved(repositoryId: number, runId: number, from: string, to: string): Promise<void> {
  if (from === to)
    return

  const run = await db
    .selectFrom('workflow_runs')
    .select(['id', 'number', 'state', 'event', 'event_ref', 'head_sha'])
    .where('id', '=', runId)
    .executeTakeFirst()

  if (!run)
    return

  await announceRun(repositoryId, {
    id: Number(run.id),
    number: Number(run.number),
    // What the row says, not what the caller computed: if a concurrent report
    // won the guarded write, the event should describe what is true.
    state: String(run.state),
    event: run.event,
    headSha: run.head_sha,
    ref: run.event_ref,
  })
}

/**
 * What a stopped run is waiting for, when it is waiting for somebody.
 *
 * Three kinds, because they need three different people. An **approval** is a
 * fork's pull request nobody has vouched for; a **gate** is a `block:` job
 * somebody with write access has to open; an **event** is an `await:` job
 * holding for something outside this instance entirely.
 *
 * Deliberately not "the run is waiting", which is also true of a run behind a
 * concurrency group and of one whose only remaining job is asleep - neither of
 * which anybody can act on. A receiver told about those would learn to ignore
 * the event, which is the failure mode of every alert that fires too often.
 */
export type ActionRequired = 'approval' | 'gate' | 'event'

/** A run has stopped and needs somebody. */
export async function announceActionRequired(
  repositoryId: number,
  run: RunFacts,
  kind: ActionRequired,
  detail?: { job?: string | null, event?: string | null },
): Promise<void> {
  try {
    const named = await identify(repositoryId)

    if (!named)
      return

    await notifyProgramsOnly('run:action_required', {
      actorId: 0,
      actorHandle: '',
      repositoryId,
      owner: named.owner,
      repository: named.repository,
      subjectType: 'repository',
      subjectId: repositoryId,
      title: kind === 'approval'
        ? `Run ${run.number} needs approval before it can start`
        : kind === 'gate'
          ? `Run ${run.number} is waiting at a gate`
          : `Run ${run.number} is waiting for an event`,
      run: {
        id: run.id,
        number: run.number,
        state: run.state,
        event: run.event ? String(run.event) : null,
        head_sha: run.headSha ? String(run.headSha) : null,
        ref: run.ref ? String(run.ref) : null,
        workflow: run.workflowName ? String(run.workflowName) : null,
      },
      // The kind travels in `action`, like every other event here: a receiver
      // that only cares about approvals reads one field.
      action: kind,
      // And which job, so a chat message can name the thing rather than the run.
      waiting: {
        job: detail?.job ? String(detail.job) : null,
        event: detail?.event ? String(detail.event) : null,
      },
    } as any)
  }
  catch (error) {
    console.error('[workflow] could not announce that a run needs somebody:', error)
  }
}

/**
 * An artifact has passed its date and gone.
 *
 * Sent after the delete, like every other event here, and it is the one that is
 * about a disappearance: a system that fetched a build output nightly keeps
 * fetching a 404, and the first person to notice is whoever needed the file.
 */
export async function announceArtifactExpired(repositoryId: number, artifact: {
  id: number
  name: string
  size: number
  runId: number
  runNumber: number
  expiresAt?: string | null
}): Promise<void> {
  try {
    const named = await identify(repositoryId)

    if (!named)
      return

    await notifyProgramsOnly('artifact:expired', {
      actorId: 0,
      actorHandle: '',
      repositoryId,
      owner: named.owner,
      repository: named.repository,
      subjectType: 'repository',
      subjectId: repositoryId,
      title: `${artifact.name} has expired`,
      action: 'expired',
      artifact: {
        id: artifact.id,
        name: artifact.name,
        size: artifact.size,
        run_id: artifact.runId,
        run_number: artifact.runNumber,
        expires_at: artifact.expiresAt ? String(artifact.expiresAt) : null,
      },
    } as any)
  }
  catch (error) {
    console.error('[workflow] could not announce an expired artifact:', error)
  }
}

/**
 * Look the run up and say it needs somebody.
 *
 * The settler and the dispatcher both know a job has stopped and neither has
 * the run's facts in hand; reading them here keeps the announcement one call at
 * the point where the state actually changed, which is the rule the rest of
 * this module follows.
 */
export async function announceActionRequiredFor(
  repositoryId: number,
  runId: number,
  kind: ActionRequired,
  detail?: { job?: string | null, event?: string | null },
): Promise<void> {
  try {
    const run = await db
      .selectFrom('workflow_runs')
      .select(['id', 'number', 'state', 'event', 'event_ref', 'head_sha'])
      .where('id', '=', runId)
      .executeTakeFirst()

    if (!run)
      return

    await announceActionRequired(repositoryId, {
      id: Number(run.id),
      number: Number(run.number),
      state: String(run.state),
      event: run.event,
      headSha: run.head_sha,
      ref: run.event_ref,
    }, kind, detail)
  }
  catch (error) {
    console.error('[workflow] could not announce that a run needs somebody:', error)
  }
}
