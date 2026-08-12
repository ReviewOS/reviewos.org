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
  const repository: any = await db
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
    } as any)
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
    } as any)
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

  const run: any = await db
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
