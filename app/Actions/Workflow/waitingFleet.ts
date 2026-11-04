import { db } from '@stacksjs/database'
import { isTrue } from '../Support/sql'
import { leaseIsLive, splitLabels } from '../Runner/protocol'
import type { FleetRunner } from './waiting'
import type { QueueFacts } from '../Runner/fleet'

/** One fleet snapshot for the run page and API, including live capacity. */
export async function waitingFleet(now = new Date()): Promise<FleetRunner[]> {
  const [runners, queues] = await Promise.all([
    db.selectFrom('runners').select(['id', 'name', 'state', 'scope_type', 'scope_id', 'labels', 'tags', 'runner_queue_id', 'last_seen_at', 'hold_reason', 'hold_started_at']).execute(),
    db.selectFrom('runner_queues')
      .innerJoin('runner_pools', 'runner_pools.id', '=', 'runner_queues.runner_pool_id')
      .select(['runner_queues.id as id', 'runner_queues.name as name', 'runner_queues.state as state', 'runner_queues.paused_reason as paused_reason', 'runner_pools.id as pool_id', 'runner_pools.name as pool_name', 'runner_pools.require_signed_steps as require_signed_steps']).execute(),
  ])
  const [memberships, held] = await Promise.all([
    queues.length ? db.selectFrom('runner_pool_repositories').select(['runner_pool_id', 'repository_id']).execute() : [],
    // A cancelling worker still owns capacity until its lease ends. Read jobs
    // across repositories, but expose no details about the occupying work.
    runners.length ? db.selectFrom('workflow_jobs').select(['runner_id', 'lease_expires_at'])
      .where('state', 'in', ['running', 'cancelling']).where('runner_id', 'in', runners.map(runner => String(runner.id))).execute() : [],
  ])
  const busy = new Set(held.filter(job => leaseIsLive({ leaseExpiresAt: job.lease_expires_at ? String(job.lease_expires_at) : null }, now)).map(job => Number(job.runner_id)))
  const byQueue = new Map<number, QueueFacts>(queues.map(queue => [Number(queue.id), {
    id: Number(queue.id), name: String(queue.name), state: String(queue.state),
    poolId: Number(queue.pool_id), poolName: String(queue.pool_name),
    pausedReason: queue.paused_reason ? String(queue.paused_reason) : null,
    repositoryIds: memberships.filter(row => Number(row.runner_pool_id) === Number(queue.pool_id)).map(row => Number(row.repository_id)),
    requireSignedSteps: isTrue(queue.require_signed_steps),
  }]))
  return runners.map(runner => ({
    id: Number(runner.id), name: String(runner.name ?? ''), state: String(runner.state),
    scopeType: String(runner.scope_type), scopeId: runner.scope_id == null ? null : Number(runner.scope_id),
    labels: splitLabels(runner.labels), tags: splitLabels(runner.tags),
    queue: byQueue.get(Number(runner.runner_queue_id)) ?? null,
    lastSeenAt: runner.last_seen_at ? String(runner.last_seen_at) : null,
    holdReason: runner.hold_reason ? String(runner.hold_reason) : null,
    holdStartedAt: runner.hold_started_at ? String(runner.hold_started_at) : null,
    busy: busy.has(Number(runner.id)),
  }))
}
