import { Job } from '@stacksjs/queue'
import { db } from '@stacksjs/database'
import { runStateFromJobs } from '../Actions/Workflow/states'
import type { JobState } from '../Actions/Workflow/states'

/**
 * Give back the work of runners that stopped talking.
 *
 * A lease lapsing is what frees a job from a machine that died - the machine
 * cannot say so, which is the whole reason leases exist. Until this job existed
 * that only happened when another runner *happened to ask* for work, so a
 * repository whose only runner crashed had a job stuck in `running` with nobody
 * coming to notice.
 *
 * Two reasons that is worse than it sounds. The run never reaches a terminal
 * state, so a pull request's checks stay pending on a machine that is gone; and
 * a fleet that is busy elsewhere never polls the queue that holds it, so the
 * failure is quietest exactly when the instance is most loaded.
 *
 * **Returned to `queued`, not failed.** A lapsed lease means the control plane
 * stopped hearing from a runner, which is not the same as the work having
 * failed - the job may even have succeeded, with the report lost on the way
 * back. Requeuing risks running it twice; failing it reports a verdict nobody
 * reached. At-least-once is the promise the protocol already makes, so the
 * first is the one that keeps it.
 */
export default new Job({
  name: 'ReclaimLapsedLeases',
  description: 'Return jobs whose runner stopped heartbeating to the queue',
  queue: 'default',
  tries: 1,

  async handle() {
    const now = new Date()

    const lapsed: any[] = await db
      .selectFrom('workflow_jobs')
      .select(['id', 'workflow_run_id', 'runner_id', 'lease_expires_at'])
      .where('state', '=', 'running')
      // Anything held with no lease at all is lapsed by definition: a running
      // job without one is a row that lost its holder, and leaving it out would
      // make the one unrecoverable case the one this job is for.
      .execute()

    const expired = lapsed.filter((job) => {
      const at = job.lease_expires_at ? Date.parse(String(job.lease_expires_at)) : Number.NaN
      return !Number.isFinite(at) || at <= now.getTime()
    })

    if (expired.length === 0)
      return { ok: true, reclaimed: 0 }

    const runs = new Set<number>()

    for (const job of expired) {
      const result: any = await db
        .updateTable('workflow_jobs')
        .set({ state: 'queued', runner_id: null, lease_expires_at: null } as any)
        .where('id', '=', Number(job.id))
        // Guarded on the state and the holder it was read at, so a runner that
        // heartbeated between the read and the write keeps its job. The sweep
        // must never take work from a machine that is alive.
        .where('state', '=', 'running')
        .where('runner_id', '=', String(job.runner_id))
        .execute()

      if (changed(result))
        runs.add(Number(job.workflow_run_id))
    }

    // A run whose only job went back to the queue is queued again rather than
    // running, and the screen should say so.
    for (const runId of runs)
      await settle(runId)

    return { ok: true, reclaimed: runs.size > 0 ? expired.length : 0 }
  },
})

/** This driver answers with a plain number; see `Runner/claim.ts`. */
function changed(result: any): boolean {
  if (typeof result === 'number')
    return result > 0

  if (typeof result === 'bigint')
    return result > 0n

  const first = Array.isArray(result) ? result[0] : result
  const affected = first?.numUpdatedRows ?? first?.numAffectedRows ?? first?.rowCount

  return affected === undefined || affected === null ? false : Number(affected) > 0
}

/** Recompute a run's state from its jobs, without moving it backwards. */
async function settle(runId: number): Promise<void> {
  const jobs: any[] = await db
    .selectFrom('workflow_jobs')
    .select(['state'])
    .where('workflow_run_id', '=', runId)
    .execute()

  const next = runStateFromJobs(jobs.map(job => String(job.state) as JobState))

  const run: any = await db
    .selectFrom('workflow_runs')
    .select(['state'])
    .where('id', '=', runId)
    .executeTakeFirst()

  const from = String(run?.state ?? '')
  if (!from || from === next)
    return

  // Terminal runs are left alone. A finished run must not be reopened by a
  // late lease expiring underneath it.
  if (['succeeded', 'failed', 'cancelled'].includes(from))
    return

  await db
    .updateTable('workflow_runs')
    .set({ state: next } as any)
    .where('id', '=', runId)
    .where('state', '=', from)
    .execute()
}
