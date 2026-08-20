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
import type { QueueFacts } from './fleet'
import { queueAccepts } from './fleet'
import { fairOrder, fleetLoad, withinQuota } from './quota'
import { fairQueueing } from '../../../config/ci-quotas'
import type { JobFacts, RunnerFacts } from './protocol'
import { leaseUntil, mayClaim, splitLabels } from './protocol'
import { isTrue } from '../Support/sql'

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
  /**
   * Whether this runner's pool refuses steps this instance did not sign.
   *
   * Told to the machine at claim rather than configured on it: an operator who
   * turns the switch on wants it to hold for every runner in the pool, not for
   * the ones whose config file somebody remembered to edit.
   */
  requireSignedSteps: boolean
  /**
   * The pool this machine is in, or null for a runner in no queue.
   *
   * Carried out of the claim because two rules are the pool's rather than the
   * job's - which plugins it permits, and what they may need - and both are
   * asked once the job is in hand.
   */
  poolId: number | null
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
      'workflow_jobs.max_parallel as max_parallel',
      'workflow_jobs.settings as settings',
      'workflow_runs.id as run_id',
      'workflow_runs.number as run_number',
      'workflow_runs.repository_id as repository_id',
      'repositories.owner_id as owner_id',
    ])
    // `queued` is the ordinary case; `running` is the one whose lease may have
    // lapsed, which is how work is recovered from a machine that died.
    .where('workflow_jobs.state', 'in', ['queued', 'running'])
    /*
     * Command jobs only, and this is a rule rather than an optimisation.
     *
     * A barrier, a gate and a trigger are the control plane's own work: they
     * are satisfied by their dependencies, by a person, or by starting another
     * run. Handing a gate to a machine would not be a scheduling mistake - it
     * would be the gate not existing, with a runner deciding a deployment
     * approval.
     */
    .where('workflow_jobs.kind', '=', 'command')
    /*
     * And only from a run that is actually meant to be going.
     *
     * A run held behind another in its concurrency group is `waiting`, and its
     * jobs are queued rows that nothing should take - holding the run rather
     * than every job is what keeps that one state change instead of a rule
     * spread across the graph. A `cancelling` run's jobs are on their way out
     * for the same reason: handing one to a machine now means a result arriving
     * for a run somebody already stopped.
     */
    .where('workflow_runs.state', 'in', ['queued', 'running'])

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
    /*
     * Priority first, then age.
     *
     * `reviewos: { priority: 10 }` on a deploy is what stops it waiting behind
     * two hundred pull request checks, and the deploy is the one somebody is
     * watching. Age breaks the tie, so equal-priority work is still first in,
     * first out - a queue that reorders equal jobs is a queue where somebody's
     * build can starve.
     */
    .orderBy('workflow_jobs.priority', 'desc')
    .orderBy('workflow_jobs.id', 'asc')
    .limit(limit)
    .execute()
}

function factsOf(row: any): JobFacts {
  return {
    id: Number(row.id),
    state: String(row.state),
    runsOn: splitLabels(row.runs_on),
    // The `agents:` query, out of the extension settings. A job that named one
    // is asking about the machine rather than about its labels.
    agents: agentsOf(row.settings),
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
  /*
   * The queue this machine serves, read once rather than per candidate.
   *
   * Null for a runner in no queue, which is the ordinary case and means the
   * fleet rules do not apply - a runner that predates pools behaves exactly as
   * it did.
   */
  const queue = await queueOf(runner.id)

  /*
   * A machine somebody asked to stop is offered nothing.
   *
   * Checked before the candidates rather than after: the point of a graceful
   * stop is that the machine takes no *new* work, and a claim that examined
   * jobs first would occasionally hand one out in the moment between the
   * request and the poll.
   */
  if (await stopRequestedFor(runner.id))
    return null

  /*
   * What the fleet is holding, read once for this poll.
   *
   * Both the ceiling and the fairness need it, and asking per candidate would
   * turn one query into fifty on the hottest path this instance has.
   */
  const load = await fleetLoad()

  // One query for the candidates either way: the fair pass reorders what came
  // back rather than asking for it twice.
  const shortlist = await candidates(runner)
  const offered = fairQueueing() ? fairOrder(shortlist, load) : shortlist

  for (const row of offered) {
    const facts = factsOf(row)

    if (!mayClaim(runner, facts, now).ok)
      continue

    /*
     * And what this repository is already holding.
     *
     * A skip rather than a failure: nothing about being over a ceiling says the
     * work is wrong, only that it is not this machine's turn. The job stays
     * queued and the next poll asks again.
     */
    if (!withinQuota(load, { repositoryId: facts.repositoryId, ownerId: facts.ownerId }))
      continue

    /*
     * The fleet rules: a paused queue hands out nothing, and a pool serves the
     * repositories it lists. Checked here rather than in SQL because the same
     * function answers the run page's "why is this queued", and two
     * implementations of a boundary is one that eventually leaks.
     */
    if (!queueAccepts(queue, facts.repositoryId).ok)
      continue

    if (await overParallelLimit(row))
      continue

    /*
     * And the named limit this job shares with every other job wearing the same
     * group, in any run of any workflow here. The deploy lock.
     */
    if (await overNamedLimit(row))
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
      })
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
    const runState = await db
      .selectFrom('workflow_runs')
      .select(['state'])
      .where('id', '=', Number(row.run_id))
      .executeTakeFirst()

    const wasQueued = String(runState?.state ?? '') === 'queued'

    if (wasQueued) {
      await db
        .updateTable('workflow_runs')
        .set({ state: 'running', started_at: now.toISOString() })
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
      requireSignedSteps: queue?.requireSignedSteps === true,
      poolId: queue?.poolId ?? null,
    }
  }

  return null
}

/**
 * `strategy.max-parallel`: whether this combination has to wait its turn.
 *
 * The key exists for a real constraint rather than for tidiness - a matrix of
 * twelve against one staging database, or against an API with a rate limit, is
 * a matrix that has to go three at a time - and a fleet that ignores it turns
 * that into twelve simultaneous failures nobody can reproduce.
 *
 * **Counted, not locked**, and that is a real limit worth stating: two runners
 * polling in the same instant can both see two running and both take the third
 * slot. Making it exact needs a lock held across the claim, which costs every
 * claim on the instance to make a per-matrix limit precise. The failure it
 * leaves is one extra job; the alternative is a queue that serialises on a
 * contended row.
 */
async function overParallelLimit(row: any): Promise<boolean> {
  const limit = Number(row.max_parallel ?? 0)

  if (!Number.isFinite(limit) || limit <= 0)
    return false

  const running = await db
    .selectFrom('workflow_jobs')
    .select(['id'])
    .where('workflow_run_id', '=', Number(row.run_id))
    // The other combinations of *this* job, which is what a matrix is: same
    // `job_id`, one row each.
    .where('job_id', '=', String(row.job_id))
    .where('state', 'in', ['running', 'cancelling'])
    .execute()

  return running.filter(other => Number(other.id) !== Number(row.id)).length >= limit
}

/**
 * The named limit a job shares with every other job wearing that name.
 *
 * `reviewos: { concurrency-group: production, concurrency: 1 }` - the deploy
 * lock, and the one staging environment three pipelines share. Actions'
 * `concurrency:` groups whole *runs*; this limits jobs, across every run and
 * every workflow in the repository, which is the only shape that serialises a
 * deploy when two different workflows can deploy.
 *
 * **Repository-wide, not instance-wide.** A group called `production` in one
 * repository is not the same lock as `production` in another, and making it so
 * would mean one team's deploy queue silently holding up another team's.
 *
 * `ordered` is the default and means the *oldest* waiting job in the group goes
 * next: a deploy queue that hands out whichever job was polled first lands an
 * older commit after a newer one, and the state of production then depends on
 * runner timing. `eager` skips that check for the case where the group is a
 * resource limit rather than a sequence.
 *
 * **Counted, not locked**, the same limitation as `max-parallel` above and for
 * the same reason: two runners polling in the same instant can both take the
 * last slot. Making it exact costs a lock on every claim on the instance.
 */
async function overNamedLimit(row: any): Promise<boolean> {
  const named = namedLimitOf(row.settings)

  if (!named)
    return false

  const held = await db
    .selectFrom('workflow_jobs')
    .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
    .select(['workflow_jobs.id as id', 'workflow_jobs.settings as settings'])
    .where('workflow_runs.repository_id', '=', Number(row.repository_id))
    .where('workflow_jobs.state', 'in', ['running', 'cancelling'])
    .execute()

  const running = held.filter(other =>
    Number(other.id) !== Number(row.id) && namedLimitOf(other.settings)?.group === named.group)

  if (running.length >= named.limit)
    return true

  if (named.method !== 'ordered')
    return false

  /*
   * Ordered: something older in this group is still waiting, so this one is not
   * next. Id order is dispatch order, which is push order - the property a
   * deploy queue is bought for.
   */
  const waiting = await db
    .selectFrom('workflow_jobs')
    .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
    .select(['workflow_jobs.id as id', 'workflow_jobs.settings as settings'])
    .where('workflow_runs.repository_id', '=', Number(row.repository_id))
    .where('workflow_jobs.state', '=', 'queued')
    .where('workflow_jobs.id', '<', Number(row.id))
    .execute()

  return waiting.some(other => namedLimitOf(other.settings)?.group === named.group)
}

/** A job's named limit, out of its settings column. Null when it named none. */
function namedLimitOf(settings: unknown): { group: string, limit: number, method: string } | null {
  try {
    const parsed = JSON.parse(String(settings ?? '{}'))
    const named = parsed?.concurrency

    if (!named || typeof named.group !== 'string' || !named.group)
      return null

    const limit = Number(named.limit)

    return {
      group: named.group,
      // A limit this cannot read is one, not unlimited: the safe direction for
      // a lock is fewer at a time, and a group whose limit decoded to zero
      // would otherwise let everything through.
      limit: Number.isInteger(limit) && limit > 0 ? limit : 1,
      method: named.method === 'eager' ? 'eager' : 'ordered',
    }
  }
  catch {
    return null
  }
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

  const result = await db
    .updateTable('workflow_jobs')
    .set({ lease_expires_at: expires })
    .where('id', '=', jobId)
    .where('runner_id', '=', String(runner.id))
    .where('state', '=', 'running')
    .execute()

  return changedSomething(result) ? expires : null
}

/**
 * The queue a runner serves, with everything the rules need, in one read.
 *
 * Per claim rather than per candidate: a runner polling every few seconds is
 * the most frequent query on the instance, and this is three joins that answer
 * the same way for every job it is about to consider.
 */
export async function queueOf(runnerId: number): Promise<QueueFacts | null> {
  const row = await db
    .selectFrom('runners')
    .innerJoin('runner_queues', 'runner_queues.id', '=', 'runners.runner_queue_id')
    .innerJoin('runner_pools', 'runner_pools.id', '=', 'runner_queues.runner_pool_id')
    .select([
      'runner_queues.id as id',
      'runner_queues.name as name',
      'runner_queues.state as state',
      'runner_queues.paused_reason as paused_reason',
      'runner_pools.id as pool_id',
      'runner_pools.name as pool_name',
      'runner_pools.require_signed_steps as require_signed_steps',
    ])
    .where('runners.id', '=', runnerId)
    .executeTakeFirst()

  if (!row)
    return null

  const permitted = await db
    .selectFrom('runner_pool_repositories')
    .select(['repository_id'])
    .where('runner_pool_id', '=', Number(row.pool_id))
    .execute()

  return {
    id: Number(row.id),
    name: String(row.name),
    state: String(row.state),
    poolId: Number(row.pool_id),
    poolName: String(row.pool_name),
    requireSignedSteps: isTrue(row.require_signed_steps) || row.require_signed_steps === 1,
    pausedReason: row.paused_reason ? String(row.paused_reason) : null,
    repositoryIds: permitted.map(entry => Number(entry.repository_id)),
  }
}

/**
 * Whether an operator has asked this machine to stop.
 *
 * Read on every claim, which is the only moment the instance can tell a runner
 * anything: it is somebody else's machine, possibly behind a firewall, and
 * there is no connection to send a signal down.
 */
export async function stopRequestedFor(runnerId: number): Promise<string | null> {
  const row = await db
    .selectFrom('runners')
    .select(['stop_requested'])
    .where('id', '=', runnerId)
    .executeTakeFirst()

  return row?.stop_requested ? String(row.stop_requested) : null
}

/** A job's `agents:` query, out of the settings column. */
function agentsOf(settings: unknown): string[] {
  try {
    const parsed = JSON.parse(String(settings ?? '{}'))

    return Array.isArray(parsed?.agents) ? parsed.agents.map(String) : []
  }
  catch {
    /*
     * Unreadable settings mean no selector, which lets the job run anywhere
     * its labels allow. The alternative - refusing every machine - would take
     * a job offline over a column nobody can read, and the labels are still a
     * real constraint.
     */
    return []
  }
}
