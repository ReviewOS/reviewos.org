import { db } from '@stacksjs/database'
import type { AwsWorkerGroupApi, Worker } from '@stacksjs/ts-cloud/drivers'
import { applyWorkerGroupPlan, DEFAULT_SPOT_FALLBACK_SECONDS, planMarket, planWorkerGroup } from '@stacksjs/ts-cloud/drivers'
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
    .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
    .select(['workflow_jobs.runs_on as runs_on'])
    .where('workflow_jobs.state', '=', 'queued')
    /*
     * The jobs a machine could actually claim, by the claim query's own rules
     * (`claim.ts`): command jobs, from runs that are meant to be going.
     *
     * Every queued row counted, and a run held behind another in its
     * concurrency group is `waiting` with all of its jobs still `queued`. A
     * push to HQ's main that queued behind the run in progress started a
     * machine for each of its jobs, and they sat idle until they timed out,
     * because nothing would hand them a job from a held run.
     */
    .where('workflow_jobs.kind', '=', 'command')
    .where('workflow_runs.state', 'in', ['queued', 'running'])
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
    // Text, as every other query on this column has it: `runner_id` is a
    // varchar, and Postgres will not compare one with an integer.
    .where('runner_id', 'in', runners.map((runner: any) => String(runner.id)))
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

/**
 * Which market the group's next launches should use: on-demand while Spot is
 * refusing launches or taking machines back, its declared share otherwise.
 *
 * Decided before capacity is raised, so the machines this tick asks for come
 * from the market that can actually supply them. On 2026-11-10 us-east-1 had
 * no spot capacity for any of HQ's six instance types for half an hour: the
 * group kept asking, the few instances that started were reclaimed minutes into
 * a job, and every HQ deploy waited behind it.
 */
export async function marketFor(api: Pick<AwsWorkerGroupApi, 'spotTrouble'>, group: RunnerGroup, current: number | null, now: Date): Promise<{ percent: number | null, reason: string | null }> {
  const hold = group.spotFallbackSeconds ?? DEFAULT_SPOT_FALLBACK_SECONDS
  // A group with no spot market, or no mixed instances policy to move, has nothing to decide.
  if (!group.market?.spot || current === null || current === undefined || hold <= 0)
    return { percent: null, reason: null }
  const trouble = await api.spotTrouble(group.name, new Date(now.getTime() - hold * 1000))
  return planMarket({ config: group, current, trouble, now })
}

export async function tickGroup(api: AwsWorkerGroupApi, group: RunnerGroup, options: { dryRun?: boolean, now?: Date } = {}): Promise<string[]> {
  const now = options.now ?? new Date()
  const state = await api.describeGroup(group.name)
  if (!state)
    return [`${group.name}: no such Auto Scaling group in ${api.region}; run runner:autoscale:apply`]

  const workers = await workersFor(state.instances.map(instance => instance.id), now)
  const waiting = await waitingFor(group)
  const plan = planWorkerGroup({
    config: group,
    currentDesired: state.desired,
    instances: state.instances,
    workers,
    waiting,
    now,
  })

  const lines = plan.reasons.map(reason => `${group.name}: ${reason}`)

  // A Spot history that cannot be read leaves the market as it is: scaling
  // still happens, and the next tick asks again.
  let market: { percent: number | null, reason: string | null } = { percent: null, reason: null }
  try {
    market = await marketFor(api, group, state.onDemandPercentage, now)
  }
  catch (error) {
    lines.push(`${group.name}: could not read its spot history, so its market stays as it is: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (market.reason)
    lines.unshift(`${group.name}: ${market.reason}`)
  /*
   * What it saw, when there was anything to see and it chose to do nothing.
   *
   * A plan with no reasons printed nothing at all, which made "nothing is
   * waiting" indistinguishable from "eight jobs are waiting and it believes
   * enough machines are on the way" - the second is a group stuck at a
   * desired capacity whose launches are failing, and the log was silent
   * through exactly that.
   */
  if (lines.length === 0 && (waiting > 0 || state.desired > 0 || state.instances.length > 0))
    lines.push(`${group.name}: ${waiting} waiting, desired ${state.desired}, ${state.instances.length} instance(s), ${workers.length} registered, ${workers.filter(worker => worker.idle).length} idle: nothing to change`)
  if (options.dryRun)
    return [...lines, `${group.name}: dry run, desired would be ${plan.desired} (now ${state.desired})${market.percent === null ? '' : `, on-demand share would be ${market.percent}%`}`]

  if (market.percent !== null)
    await api.setOnDemandShare(group.name, market.percent)
  await applyWorkerGroupPlan(api, group.name, state.desired, plan)
  return lines
}
