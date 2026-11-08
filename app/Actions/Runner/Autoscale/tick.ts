import { db } from '@stacksjs/database'
import type { AwsWorkerGroupApi, Worker } from '@stacksjs/ts-cloud/drivers'
import { applyWorkerGroupPlan, planWorkerGroup } from '@stacksjs/ts-cloud/drivers'
import { resolveRepository } from '../../Identity/lookup'
import { runnerLifecycle } from '../fleet'
import type { RunnerGroup } from './types'

/**
 * One scaling decision for one runner group. ts-cloud decides the capacity
 * and talks to AWS; this file supplies the two facts only ReviewOS has - how
 * many jobs are waiting for the group, and which of its instances became
 * runners and whether they are free.
 *
 * Waiting work is counted here rather than taken from `/api/metrics`, which
 * attributes a job to a queue by the labels its *current* machines answer to -
 * so a group scaled to zero would report no work, which is exactly the moment
 * it needs some. A job is the group's when it belongs to one of the group's
 * repositories and every label it asks for is one the group's runners carry.
 */
export function jobFits(runsOn: string | null, labels: readonly string[]): boolean {
  const wanted = String(runsOn ?? '').split('\n').map(line => line.trim()).filter(Boolean)
  return wanted.length > 0 && wanted.every(label => labels.includes(label))
}

export async function waitingFor(group: RunnerGroup): Promise<number> {
  const ids: number[] = []
  for (const full of group.repositories) {
    const [owner, name] = full.split('/')
    const repository = owner && name ? await resolveRepository(owner, name) : null
    if (repository)
      ids.push(Number(repository.id))
  }
  if (ids.length === 0)
    return 0

  const jobs = await db
    .selectFrom('workflow_jobs')
    .innerJoin('workflow_runs', 'workflow_runs.id', 'workflow_jobs.workflow_run_id')
    .select(['workflow_jobs.runs_on as runs_on'])
    .where('workflow_jobs.state', '=', 'queued')
    .where('workflow_runs.repository_id', 'in', ids)
    .execute()

  return jobs.filter((job: any) => jobFits(job.runs_on, group.labels)).length
}

/** The group's instances that became runners: each runner is named after its instance. */
export async function workersFor(instanceIds: string[], now: Date = new Date()): Promise<Worker[]> {
  if (instanceIds.length === 0)
    return []
  const runners = await db
    .selectFrom('runners')
    .select(['id', 'name', 'state', 'last_seen_at', 'stop_requested', 'hold_reason'])
    .where('name', 'in', instanceIds)
    .execute()
  if (runners.length === 0)
    return []
  const held = await db
    .selectFrom('workflow_jobs')
    .select(['runner_id', 'lease_expires_at'])
    .where('state', '=', 'running')
    .where('runner_id', 'in', runners.map((runner: any) => Number(runner.id)))
    .execute()

  return runners.map((runner: any) => {
    const holding = held.find((job: any) => Number(job.runner_id) === Number(runner.id))
    const lease = holding?.lease_expires_at ? Date.parse(String(holding.lease_expires_at)) : Number.NaN
    const lifecycle = runnerLifecycle({
      state: String(runner.state),
      lastSeenAt: runner.last_seen_at ? String(runner.last_seen_at) : null,
      stopRequested: runner.stop_requested ? String(runner.stop_requested) : null,
      holdsJob: Boolean(holding),
      leaseLapsed: Boolean(holding) && Number.isFinite(lease) && lease <= now.getTime(),
      holdReason: runner.hold_reason ? String(runner.hold_reason) : null,
    }, now)
    return { name: String(runner.name), idle: lifecycle === 'idle' }
  })
}

export async function tickGroup(api: AwsWorkerGroupApi, group: RunnerGroup, options: { dryRun?: boolean, now?: Date } = {}): Promise<string[]> {
  const now = options.now ?? new Date()
  const state = await api.describeGroup(group.name)
  if (!state)
    return [`${group.name}: no such Auto Scaling group in ${api.region}; run runner:autoscale:apply`]

  const plan = planWorkerGroup({
    config: group,
    currentDesired: state.desired,
    instances: state.instances,
    workers: await workersFor(state.instances.map(instance => instance.id), now),
    waiting: await waitingFor(group),
    now,
  })

  const lines = plan.reasons.map(reason => `${group.name}: ${reason}`)
  if (options.dryRun)
    return [...lines, `${group.name}: dry run, desired would be ${plan.desired} (now ${state.desired})`]

  await applyWorkerGroupPlan(api, group.name, state.desired, plan)
  return lines
}
