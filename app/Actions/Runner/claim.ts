/**
 * Hand one job to one runner.
 *
 * The rules for *whether* a runner may have a job are in
 * [protocol.ts](./protocol.ts) and tested there. This is the part that touches
 * the database, and its whole job is to make sure the answer survives two
 * runners asking at the same instant.
 *
 * **The guard is in the `WHERE`, not in an `if`.** Reading a job, deciding it
 * is free, and then writing the lease is two statements with a gap in the
 * middle, and the gap is exactly long enough for another runner to do the same.
 * The update names the state it expects to find, and a claim that changed no
 * rows means somebody else got there first - which is an ordinary outcome, not
 * an error.
 */

import { db } from '@stacksjs/database'
import { announceJob, announceRunIfMoved } from '../Workflow/announce'
import { hashToken } from './authenticate'
import type { JobFacts, RunnerFacts } from './protocol'
import { leaseUntil, mayClaim, splitLabels } from './protocol'

/**
 * A credential good for one job.
 *
 * Random rather than derived: a token computed from the job id and a secret is
 * a token an attacker can compute too, given the id and a leak of the secret,
 * and the id is not private.
 */
function mintJobToken(): string {
  return `job-${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex')}`
}

export interface ClaimedJob {
  jobId: number
  runId: number
  repositoryId: number
  jobKey: string
  leaseExpiresAt: string
  /**
   * The credential for this claim, returned once and never stored in the clear.
   *
   * Everything after the claim is authenticated with this rather than with the
   * registration token, which is the credential an operator installs once and
   * never rotates. Handing the long-lived one to every call - and eventually to
   * a job environment - is what the threat model forbids.
   */
  jobToken: string
}

/**
 * Jobs that could plausibly go to this runner, newest last.
 *
 * Deliberately a shortlist rather than one row: the label and scope rules are
 * in TypeScript, where they are tested, so the query fetches the candidates and
 * the decision stays in one place. A repository with thousands of queued jobs
 * would want this narrowed in SQL - the limit is what keeps that from being
 * urgent.
 */
async function candidates(runner: RunnerFacts, limit = 50): Promise<any[]> {
  let query = db
    .selectFrom('workflow_jobs')
    .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
    .innerJoin('repositories', 'repositories.id', '=', 'workflow_runs.repository_id')
    .select([
      'workflow_jobs.id as id',
      'workflow_jobs.job_id as job_id',
      'workflow_jobs.name as name',
      'workflow_jobs.state as state',
      'workflow_jobs.runs_on as runs_on',
      'workflow_jobs.runner_id as runner_id',
      'workflow_jobs.lease_expires_at as lease_expires_at',
      'workflow_runs.id as run_id',
      'workflow_runs.number as run_number',
      'workflow_runs.repository_id as repository_id',
      'repositories.owner_id as owner_id',
    ])
    // `queued` is the ordinary case; `running` is the one whose lease may have
    // lapsed, which is how work is recovered from a machine that died.
    .where('workflow_jobs.state', 'in', ['queued', 'running'])

  // Narrowed in SQL where it is cheap and safe to do so. The authoritative
  // check is still `runnerReaches`, so a mistake here costs a wasted row rather
  // than a repository's source going to the wrong machine.
  //
  // Added before `orderBy` and `limit`, not after: a `where` appended to a
  // query that already carries a `LIMIT` is spliced in after it, and Postgres
  // answers "argument of AND must be type boolean, not type integer" - the
  // limit itself having become one side of the condition.
  if (runner.scopeType === 'repository' && runner.scopeId !== null)
    query = query.where('workflow_runs.repository_id', '=', runner.scopeId)

  if (runner.scopeType === 'organization' && runner.scopeId !== null)
    query = query.where('repositories.owner_id', '=', runner.scopeId)

  return query
    .orderBy('workflow_jobs.id', 'asc')
    .limit(limit)
    .execute()
}

function factsOf(row: any): JobFacts {
  return {
    id: Number(row.id),
    state: String(row.state),
    runsOn: splitLabels(row.runs_on),
    repositoryId: Number(row.repository_id),
    ownerId: Number(row.owner_id),
    runnerId: row.runner_id === null ? null : Number(row.runner_id),
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
  }
}

/**
 * Take the first job this runner may have, or null.
 *
 * Null is the common answer - most polls find nothing - so it is not an error
 * and does not log. A runner asking every few seconds must not fill a log with
 * its own patience.
 */
export async function claimNextJob(
  runner: RunnerFacts,
  now: Date = new Date(),
): Promise<ClaimedJob | null> {
  for (const row of await candidates(runner)) {
    const facts = factsOf(row)

    if (!mayClaim(runner, facts, now).ok)
      continue

    const expires = leaseUntil(now)
    const token = mintJobToken()

    /*
     * The claim itself. Conditioned on the job still being where it was when it
     * was read: either unheld, or held by a lease that has already lapsed.
     * Another runner winning the race changes the row, this matches nothing,
     * and the loop moves on to the next candidate.
     */
    const held = facts.runnerId !== null

    let update = db
      .updateTable('workflow_jobs')
      .set({
        state: 'running',
        runner_id: String(runner.id),
        lease_expires_at: expires,
        started_at: row.started_at ?? now.toISOString(),
        // Minted per claim, so recovering a lapsed lease invalidates the dead
        // runner's token in the same write that hands the work on.
        job_token_hash: hashToken(token),
      } as any)
      .where('id', '=', facts.id)

    update = held
      // Recovering an expired lease: only if it is still the same stale holder.
      ? update.where('runner_id', '=', String(facts.runnerId)).where('lease_expires_at', '=', facts.leaseExpiresAt)
      // Taking a free one: only if nobody has taken it since. `whereNull`
      // rather than `where(col, 'is', null)`, which this builder compiles into
      // a bound parameter and Postgres rejects as a syntax error.
      : update.where('state', '=', 'queued').whereNull('runner_id')

    const result: any = await update.execute()

    if (!changedSomething(result))
      continue

    /*
     * Work started, said out loud.
     *
     * After the write, so a receiver that reads the job back sees it held. The
     * run follows the job: a run whose first job was just claimed is running,
     * and a dashboard that hears "job running" while the run still says
     * "queued" has to guess which one is stale.
     */
    const runState: any = await db
      .selectFrom('workflow_runs')
      .select(['state'])
      .where('id', '=', Number(row.run_id))
      .executeTakeFirst()

    const wasQueued = String(runState?.state ?? '') === 'queued'

    if (wasQueued) {
      await db
        .updateTable('workflow_runs')
        .set({ state: 'running', started_at: now.toISOString() } as any)
        .where('id', '=', Number(row.run_id))
        .where('state', '=', 'queued')
        .execute()
    }

    await announceJob(facts.repositoryId, {
      id: facts.id,
      jobId: String(row.job_id),
      name: row.name ? String(row.name) : String(row.job_id),
      state: 'running',
      runId: Number(row.run_id),
      runNumber: Number(row.run_number ?? 0),
      runnerId: String(runner.id),
    })

    if (wasQueued)
      await announceRunIfMoved(facts.repositoryId, Number(row.run_id), 'queued', 'running')

    return {
      jobId: facts.id,
      runId: Number(row.run_id),
      repositoryId: facts.repositoryId,
      jobKey: String(row.job_id),
      leaseExpiresAt: expires,
      jobToken: token,
    }
  }

  return null
}

/**
 * Whether an update touched a row.
 *
 * This driver answers with a plain number, which the first version of this
 * function did not handle: it looked for `numUpdatedRows` on the result, found
 * nothing on a `0`, and fell through to "assume it worked". So an update that
 * matched no rows reported success - which is the whole guard inverted. A
 * runner could extend a lease on a job it did not hold, and two runners racing
 * would both be told they had won.
 *
 * **Unknown counts as failure.** A claim that wrongly fails is visible - the
 * job stays queued and is offered again - and a claim that wrongly succeeds is
 * two machines running the same job while the control plane believes one is.
 */
function changedSomething(result: any): boolean {
  if (typeof result === 'number')
    return result > 0

  if (typeof result === 'bigint')
    return result > 0n

  const first = Array.isArray(result) ? result[0] : result
  const affected = first?.numUpdatedRows ?? first?.numAffectedRows ?? first?.rowCount

  return affected === undefined || affected === null ? false : Number(affected) > 0
}

/**
 * Extend the lease a runner already holds.
 *
 * The heartbeat. Short leases plus renewal is what makes a dead machine
 * recoverable without anybody noticing, and the alternative - a long lease -
 * means a job held by a machine that fell over is stuck for as long as it.
 */
export async function heartbeat(
  runner: RunnerFacts,
  jobId: number,
  now: Date = new Date(),
): Promise<string | null> {
  const expires = leaseUntil(now)

  const result: any = await db
    .updateTable('workflow_jobs')
    .set({ lease_expires_at: expires } as any)
    .where('id', '=', jobId)
    .where('runner_id', '=', String(runner.id))
    .where('state', '=', 'running')
    .execute()

  return changedSomething(result) ? expires : null
}
