/**
 * Putting a sleeping run back on a machine when its time comes.
 *
 * A suspended run holds nothing. That is the point of suspending it - a
 * workflow waiting three days for an approval must not hold a lease for three
 * days - but it is also the problem: a run that holds nothing is a run nothing
 * is looking at. `record` will end the sleep correctly the moment somebody asks
 * again, and without this, nobody ever does.
 *
 * ## Requeue the job, do not resolve the call
 *
 * This sweep does not touch the journal. It puts the orchestrator job back in
 * the queue and stops; a runner claims it, the program replays from its first
 * line, and the sleep ends where every other decision about the journal is
 * made. Ending it here as well would be a second place that decides when a
 * sleep is over, and two places that decide one thing eventually disagree.
 *
 * ## Why it is safe to run every minute
 *
 * The requeue is guarded on the job's state, so a run whose orchestrator is
 * already queued or already running is left alone. Waking a run that is awake
 * would hand two orchestrators to one run - which the journal survives, since
 * the unique index picks a winner, but surviving a thing is not a reason to
 * cause it.
 */

import { db } from '@stacksjs/database'
import { rowsChanged } from '../Support/sql'

/** A run whose orchestrator should be running again. */
export interface DueSleep {
  runId: number
  jobId: number
  entryId: number
  wakeAt: string
}

/**
 * Sleeps whose time has come, on runs that are still going.
 *
 * The state filter is not an optimization. A run somebody cancelled while it
 * slept must stay cancelled, and a sweep that woke it would restart work the
 * person had already stopped - which is worse than the sleep never ending.
 */
export async function dueSleeps(now: Date, limit = 200): Promise<DueSleep[]> {
  const rows: any[] = await db
    .selectFrom('workflow_journal_entries')
    .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_journal_entries.workflow_run_id')
    .innerJoin('workflow_jobs', 'workflow_jobs.workflow_run_id', '=', 'workflow_runs.id')
    .select([
      'workflow_journal_entries.id as entry_id',
      'workflow_journal_entries.wake_at as wake_at',
      'workflow_runs.id as run_id',
      'workflow_jobs.id as job_id',
    ])
    .where('workflow_journal_entries.kind', '=', 'sleep')
    .where('workflow_journal_entries.state', '=', 'pending')
    .where('workflow_journal_entries.wake_at', '<=', now.toISOString())
    .where('workflow_runs.state', 'in', ['running', 'queued'])
    .where('workflow_jobs.orchestrator', '=', true)
    // Only a job that is not already on a machine. One that is running is one
    // whose program is about to ask about this sleep by itself.
    .where('workflow_jobs.state', 'in', ['queued', 'sleeping'])
    .orderBy('workflow_journal_entries.wake_at', 'asc')
    .limit(limit)
    .execute()
    .catch(() => [])

  return rows.map(row => ({
    runId: Number(row.run_id),
    jobId: Number(row.job_id),
    entryId: Number(row.entry_id),
    wakeAt: String(row.wake_at ?? ''),
  }))
}

/**
 * Put one sleeping orchestrator back in the queue.
 *
 * Returns whether it actually moved. The guard on `state` is what makes this
 * idempotent: two sweeps overlapping, or a sweep racing a runner that just
 * claimed the job, resolve to one requeue rather than two.
 *
 * The credential goes with the requeue for the same reason it does when a lease
 * lapses: the token was minted for one machine's attempt at this job, and the
 * next attempt is somebody else's.
 */
export async function wakeOne(jobId: number): Promise<boolean> {
  const result: any = await db
    .updateTable('workflow_jobs')
    .set({
      state: 'queued',
      runner_id: null,
      lease_expires_at: null,
      job_token_hash: null,
      // Waiting for a machine from now, not from whenever the run was first
      // dispatched - a sleep of three days would otherwise look like three days
      // of queueing on every screen that reads this.
      queued_at: new Date().toISOString(),
    })
    .where('id', '=', jobId)
    .where('state', '=', 'sleeping')
    .execute()

  return rowsChanged(result)
}

/**
 * The other way a suspended run resumes: something happened.
 *
 * A workflow waiting three days for an approval is not waiting for three days -
 * it is waiting for a person, and the three days is only the point at which
 * waiting stops being reasonable. So an orchestrator may park on a **name**
 * rather than on a time, and this is what unparks it.
 *
 * Resolved with the payload, so the call returns something: `await
 * context.waitFor('approval')` gives the program who approved it and when,
 * which is the difference between an event that resumes a workflow and one that
 * merely unblocks it.
 *
 * Returns whether anything was waiting. A false is not an error - an event
 * arriving for a run that never asked for it is ordinary, and the alternative
 * is every caller checking first and racing anyway.
 */
export async function deliverEvent(runId: number, name: string, payload: unknown = null): Promise<boolean> {
  const entry: any = await db
    .selectFrom('workflow_journal_entries')
    .select(['id'])
    .where('workflow_run_id', '=', runId)
    .where('kind', '=', 'event')
    .where('name', '=', name)
    .where('state', '=', 'pending')
    // The earliest still waiting, so a program that waits on one name twice
    // receives the two events in the order they arrived.
    .orderBy('sequence', 'asc')
    .executeTakeFirst()
    .catch(() => null)

  if (!entry)
    return false

  await db
    .updateTable('workflow_journal_entries')
    .set({ state: 'done', result: JSON.stringify(payload ?? null), wake_at: null })
    .where('id', '=', Number(entry.id))
    // Guarded, so an event delivered twice - a retried webhook, two people
    // clicking approve - resolves the call once with the first payload rather
    // than overwriting it with the second.
    .where('state', '=', 'pending')
    .execute()

  const job: any = await db
    .selectFrom('workflow_jobs')
    .select(['id'])
    .where('workflow_run_id', '=', runId)
    .where('orchestrator', '=', true)
    .where('state', '=', 'sleeping')
    .executeTakeFirst()
    .catch(() => null)

  if (job)
    await wakeOne(Number(job.id))

  return true
}

/** Wake every run whose sleep is due. */
export async function wakeSleepingRuns(now: Date = new Date()): Promise<{ woken: number, due: number }> {
  const due = await dueSleeps(now)
  let woken = 0

  for (const sleep of due) {
    if (await wakeOne(sleep.jobId))
      woken += 1
  }

  return { woken, due: due.length }
}
