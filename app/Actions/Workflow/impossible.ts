/**
 * Jobs no machine on this instance could ever take, failed rather than left.
 *
 * A queued job is a promise that something will happen. When the fleet has
 * nothing that answers to `macos-14` and never will until somebody registers
 * one, that promise is false - and the run holds a pull request's checks open
 * indefinitely on work that is not going to be done. The reason was already
 * computable and already on the screen; what was missing was anything acting on
 * it.
 *
 * ## The distinction this rests on
 *
 * **A capability nobody has is not the same as a fleet that is busy.** Every
 * machine being occupied, switched off, or in a drained queue is a wait: the
 * job runs when one frees up, and failing it would be the instance giving up on
 * work it is perfectly able to do. A label no registered runner carries, a pool
 * that refuses this repository, or a tag query nothing reported is a different
 * thing - no amount of waiting changes it.
 *
 * `explainWaiting` already tells those apart, kind by kind, and it is the same
 * function the run screen explains with. Two rules would eventually disagree,
 * and the one on the screen would be the one people believed.
 *
 * A pool that refuses a repository is deliberately *not* in the list, though it
 * is just as permanent: it is an operator's decision about their own fleet, and
 * an operator who changes their mind should find the work still waiting rather
 * than a morning of failed runs to re-run.
 *
 * ## Why there is a grace period
 *
 * Because "nothing answers to this label" is also what a correct instance looks
 * like for the sixty seconds between a workflow landing and an operator
 * registering the runner for it. An hour is long enough that a job failed this
 * way is genuinely impossible, and short enough that nobody waits a working day
 * to be told.
 */

import { db } from '@stacksjs/database'
import type { FleetRunner } from './waiting'
import { explainWaiting } from './waiting'
import { settleRun } from './settle'
import { splitLabels } from '../Runner/protocol'
import { rowsChanged } from '../Support/sql'

/**
 * The waiting kinds that no amount of waiting fixes.
 *
 * Deliberately a list of what *is* impossible rather than what is not: a new
 * kind added to the explanation is one this sweep ignores until somebody says
 * otherwise, which is the safe direction - the cost of missing one is a job
 * that waits, and the cost of guessing wrong is a job failed while a machine
 * that could have run it was booting.
 */
const IMPOSSIBLE = ['no-labels', 'none-reach', 'no-tags']

/** How long a job waits before "nothing can run this" is believed. */
const GRACE_MS = 60 * 60 * 1000

export interface ImpossibleOutcome {
  /** How many jobs were failed for asking for something nothing has. */
  failed: number
}

/**
 * Fail the queued jobs nothing could take, with the reason and the fix.
 *
 * The message is the explanation the run screen shows, so somebody reading the
 * failed job and somebody reading the queued job an hour earlier are told the
 * same thing - and the fix travels with it, because "no runner has `macos-14`"
 * without "the runners that could take this have `ubuntu-latest`" is half an
 * answer.
 */
export async function failImpossibleJobs(now: Date = new Date()): Promise<ImpossibleOutcome> {
  const cutoff = new Date(now.getTime() - GRACE_MS).toISOString()

  const waiting = await db
    .selectFrom('workflow_jobs')
    .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
    .innerJoin('repositories', 'repositories.id', '=', 'workflow_runs.repository_id')
    .select([
      'workflow_jobs.id as id',
      'workflow_jobs.state as state',
      'workflow_jobs.runs_on as runs_on',
      'workflow_jobs.settings as settings',
      'workflow_jobs.workflow_run_id as run_id',
      'workflow_runs.repository_id as repository_id',
      'repositories.owner_id as owner_id',
    ])
    .where('workflow_jobs.state', '=', 'queued')
    .where('workflow_jobs.kind', '=', 'command')
    .where('workflow_jobs.queued_at', '<', cutoff)
    // Only from runs that are actually going: a held or cancelling run's queued
    // rows are not waiting for a machine, and failing them would be this sweep
    // deciding something another rule already decided.
    .where('workflow_runs.state', 'in', ['queued', 'running'])
    .limit(500)
    .execute()
    .catch(() => [])

  if (waiting.length === 0)
    return { failed: 0 }

  const runners = await fleet()
  const outcome: ImpossibleOutcome = { failed: 0 }
  const touched = new Set<number>()

  for (const job of waiting as any[]) {
    const verdict = explainWaiting({
      id: Number(job.id),
      state: String(job.state),
      runsOn: splitLabels(job.runs_on),
      agents: agentsOf(job.settings),
      repositoryId: Number(job.repository_id),
      ownerId: Number(job.owner_id ?? 0),
      runnerId: null,
      leaseExpiresAt: null,
    }, runners)

    if (!IMPOSSIBLE.includes(verdict.kind))
      continue

    const changed = await db
      .updateTable('workflow_jobs')
      .set({
        state: 'failed',
        finished_at: now.toISOString(),
        // The summary and the fix together, because the first says what is
        // wrong and only the second says what to do about it.
        condition_reason: `${verdict.summary} ${verdict.fix}`.slice(0, 1000),
      })
      .where('id', '=', Number(job.id))
      // Guarded on the state it was read at: a runner registered while this
      // sweep was running may have taken the job a moment ago, and taking work
      // from a machine that is doing it is the direction that does damage.
      .where('state', '=', 'queued')
      .execute()
      .catch(() => null)

    if (!rowsChanged(changed))
      continue

    outcome.failed += 1
    touched.add(Number(job.run_id))
  }

  /*
   * Settled once per run rather than once per job. A matrix of twenty jobs
   * asking for a label nobody has is one run reaching its conclusion, not
   * twenty settles of the same run.
   */
  for (const runId of touched)
    await settleRun(runId, now).catch(() => null)

  return outcome
}

/**
 * The fleet as the explanation reads it.
 *
 * The same fields the run screen passes, and no queue facts - which is why the
 * pool kinds cannot fire here. That is the intended shape rather than an
 * omission: this sweep only ever acts on what a machine *is*, and what a pool
 * is willing to serve is what an operator decided this morning.
 */
async function fleet(): Promise<FleetRunner[]> {
  const rows = await db
    .selectFrom('runners')
    .select(['id', 'state', 'scope_type', 'scope_id', 'labels', 'tags'])
    .execute()
    .catch(() => [])

  return (rows as any[]).map(runner => ({
    id: Number(runner.id),
    state: String(runner.state),
    scopeType: String(runner.scope_type),
    scopeId: runner.scope_id === null || runner.scope_id === undefined ? null : Number(runner.scope_id),
    labels: splitLabels(runner.labels),
    tags: splitLabels(runner.tags),
  }))
}

/** `reviewos.agents:` off the job's settings, or nothing. */
function agentsOf(settings: unknown): string[] {
  try {
    const parsed = JSON.parse(String(settings ?? '{}'))

    return Array.isArray(parsed?.agents) ? parsed.agents.map((one: unknown) => String(one)) : []
  }
  catch {
    return []
  }
}

