// A runner group whose launches never become runners.
//
// On 2026-11-13 every instance HQ's AWS group launched died two and a half
// minutes into its boot, before registering. The scaler launched a
// replacement every minute for twenty-one hours and told nobody. This replays
// that against the two decisions ts-cloud makes (`planLaunchBackoff`,
// `planWorkerGroup`) and the bookkeeping ReviewOS adds (`noteBackoff`), with
// AWS and the database stood in for by a list and an object.
//
// `tests/e2e/autoscale-backoff.test.ts` runs the same thing through
// `tickGroup` against the real tables.

import type { WorkerLaunch } from '@stacksjs/ts-cloud/drivers'
import type { BackoffRecord, BackoffStore } from '../../app/Actions/Runner/Autoscale/backoff'
import type { OperatorAlert } from '../../app/Ops/alerts'
import { describe, expect, test } from 'bun:test'
import { planLaunchBackoff, planMarket, planWorkerGroup } from '@stacksjs/ts-cloud/drivers'
import { BACKOFF_GUIDE, backoffStep, noteBackoff } from '../../app/Actions/Runner/Autoscale/backoff'
import { defaultDelivery } from '../../app/Actions/Notification/preferences'
import { reasonLabel } from '../../app/Actions/Notification/inbox'
import { autoscalingGroups } from '../../cloud/autoscaling'

const group = autoscalingGroups['hq-aws']!
const start = new Date('2026-11-13T21:04:00Z')
const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000)

/** The group's record, kept the way the database keeps it: outside the scaler. */
function memory(): BackoffStore & { record: BackoffRecord | null, writes: number } {
  const store = {
    record: null as BackoffRecord | null,
    writes: 0,
    read: async () => store.record,
    create: async (_group: string, record: BackoffRecord) => {
      store.record = record
      store.writes++
      return true
    },
    update: async (_group: string, record: BackoffRecord) => {
      store.record = record
      store.writes++
    },
  }
  return store
}

/**
 * One group in a pretend AWS. An instance lives for two and a half minutes
 * unless it registers, lowers the desired capacity when it goes, and the
 * scaler ticks once a minute with `waiting` jobs in the queue.
 */
function world(options: { waiting: number, boots: (launch: WorkerLaunch) => boolean, reclaimed?: (launch: WorkerLaunch) => boolean }) {
  const launches: WorkerLaunch[] = []
  const alerts: OperatorAlert[] = []
  const lines: string[] = []
  const store = memory()
  let waiting = options.waiting

  const registered = (time: Date) => launches.filter(launch => options.boots(launch) && time.getTime() - launch.at.getTime() >= 60_000).map(launch => launch.id)
  const alive = (time: Date) => launches.filter(launch => (options.boots(launch) && !options.reclaimed?.(launch)) || time.getTime() - launch.at.getTime() < 150_000)

  async function tick(time: Date) {
    const up = alive(time)
    const names = registered(time)
    const instances = up.map(launch => ({ id: launch.id, lifecycle: 'InService', launchedAt: launch.at }))
    const workers = up.filter(launch => names.includes(launch.id)).map(launch => ({ name: launch.id, idle: false }))
    const reclaimed = launches.filter(launch => options.reclaimed?.(launch)).map(launch => launch.id)
    const backoff = planLaunchBackoff({ config: group, launches, instances, registered: names, reclaimed, now: time })
    const plan = planWorkerGroup({ config: group, currentDesired: up.length, instances, workers, waiting, backoff, now: time })
    for (let have = up.length; have < plan.desired; have++)
      launches.push({ id: `i-${String(launches.length + 1).padStart(17, '0')}`, at: time })
    lines.push(...plan.reasons)
    lines.push(...await noteBackoff(group, backoff, { now: time, registered: launches.find(launch => names.includes(launch.id))?.id ?? null, store, tell: async (alert) => { alerts.push(alert) } }))
    return { backoff, plan }
  }

  return { launches, alerts, lines, store, tick, setWaiting: (count: number) => { waiting = count } }
}

describe('2026-11-13: every launch dies at boot for twenty-one hours', () => {
  const fixedAt = at(21 * 60)
  const hq = world({ waiting: 8, boots: launch => launch.at.getTime() >= fixedAt.getTime() })

  test('the launches thin out to one every half hour, and the operators are told once', async () => {
    for (let minute = 0; minute < 21 * 60; minute++)
      await hq.tick(at(minute))

    // Without the backoff this was a launch a minute: about 1,260.
    expect(hq.launches.length).toBeGreaterThan(40)
    expect(hq.launches.length).toBeLessThan(60)

    // Six at once, as the queue asked. Then one probe at a time.
    expect(hq.launches.slice(0, 6).every(launch => launch.at.getTime() === start.getTime())).toBe(true)
    const gaps = hq.launches.slice(6).map((launch, index) => (launch.at.getTime() - hq.launches[5 + index]!.at.getTime()) / 60_000)
    expect(gaps[0]).toBe(16)
    expect(new Set(gaps.slice(1))).toEqual(new Set([30]))

    expect(hq.alerts).toHaveLength(1)
    const alert = hq.alerts[0]!
    expect(alert.kind).toBe('problem')
    expect(alert.event).toBe('ops:runner-group')
    expect(alert.title).toBe('Runner group reviewos-runner-hq: 6 launches in a row never became runners (since 2026-11-13 21:04 UTC)')
    // What was seen, since when, when it tries next, and where to look.
    expect(alert.detail).toContain('jobs for stacks/hq.training are waiting')
    expect(alert.detail).toContain('the next is due at 2026-11-13 21:20 UTC')
    expect(alert.detail).toContain('aws ec2 get-console-output --region us-east-1 --instance-id i-00000000000000001 --latest --output text')
    expect(alert.url).toBe(BACKOFF_GUIDE)
    expect(alert.context).toMatchObject({ group: 'reviewos-runner-hq', died: 6, since: '2026-11-13T21:04:00Z' })
  })

  test('the log says it is backing off and when it tries next, on every tick with work behind it', () => {
    const held = hq.lines.filter(line => line.includes('ended without a worker'))
    expect(held.length).toBeGreaterThan(1200)
    expect(held).toContain('6 launch(es) in a row ended without a worker since 2026-11-13T21:04:00Z: backing off, next probe at 2026-11-13T21:20:00Z')
    expect(hq.lines.filter(line => line.includes('told the operators'))).toHaveLength(1)
  })

  test('the record says the incident is open, with the most launches it saw', () => {
    expect(hq.store.record).toMatchObject({ since: '2026-11-13T21:04:00Z', alerted_at: '2026-11-13T21:07:00Z', recovered_at: null })
    expect(hq.store.record!.died).toBe(hq.launches.length)
    // Written when something changed, not once a minute.
    expect(hq.store.writes).toBeLessThan(hq.launches.length * 2)
  })

  test('a scheduler that restarts mid-incident tells nobody again', async () => {
    // Everything the scaler knows is the launch record and the row: a "new
    // process" is the same call with nothing carried over.
    const before = hq.alerts.length
    const { backoff } = await hq.tick(at(21 * 60 - 0.5))
    expect(backoff.backingOff).toBe(true)
    expect(hq.alerts).toHaveLength(before)
  })

  test('the boot is fixed: one probe registers, scaling is normal again, and they are told once', async () => {
    const before = hq.launches.length
    let minute = 21 * 60
    while (hq.launches.length === before)
      await hq.tick(at(minute++))
    // Still one probe, even with eight jobs waiting.
    expect(hq.launches.length).toBe(before + 1)
    const probe = hq.launches.at(-1)!

    const after = await hq.tick(at(minute))
    expect(after.backoff.backingOff).toBe(false)
    // The queue decides again: the group goes straight to its maximum.
    expect(after.plan.desired).toBe(group.max)
    expect(hq.launches.length).toBe(before + group.max)

    for (let more = 1; more <= 180; more++)
      await hq.tick(at(minute + more))

    expect(hq.alerts).toHaveLength(2)
    const notice = hq.alerts[1]!
    expect(notice.kind).toBe('recovered')
    expect(notice.title).toBe('Runner group reviewos-runner-hq is launching runners again')
    expect(notice.detail).toContain(`${probe.id} registered as a runner, after ${before} launches in a row that never did (since 2026-11-13 21:04 UTC)`)
    expect(hq.store.record).toMatchObject({ next_probe_at: null })
    expect(hq.store.record!.recovered_at).not.toBeNull()
    expect(hq.launches.length).toBe(before + group.max)
  })

  test('a second incident, later, is a second alert', async () => {
    const again = backoffStep(hq.store.record, { backingOff: true, died: 3, since: at(3000), example: 'i-0aaaaaaaaaaaaaaaa', nextProbeAt: at(3004) }, at(3003))
    expect(again.tell).toBe('problem')
    expect(again.write).toMatchObject({ died: 3, since: '2026-11-15T23:04:00Z', alerted_at: '2026-11-15T23:07:00Z', recovered_at: null })
  })
})

describe('groups that are fine are left alone', () => {
  test('a healthy group scales by the queue all day and nobody hears about it', async () => {
    const healthy = world({ waiting: 4, boots: () => true })
    for (let minute = 0; minute < 24 * 60; minute++) {
      healthy.setWaiting(minute % 90 < 10 ? 4 : 0)
      const { backoff } = await healthy.tick(at(minute))
      expect(backoff.backingOff).toBe(false)
    }
    expect(healthy.alerts).toEqual([])
    expect(healthy.store.record).toBeNull()
    expect(healthy.store.writes).toBe(0)
    expect(healthy.lines.some(line => line.includes('ended without a worker'))).toBe(false)
  })

  test('one bad boot between good ones is not an incident', async () => {
    const flaky = world({ waiting: 1, boots: launch => Number(launch.id.slice(2)) % 3 !== 0 })
    for (let minute = 0; minute < 6 * 60; minute++)
      await flaky.tick(at(minute))
    expect(flaky.alerts).toEqual([])
  })

  test('a spot shortage is the market\'s problem: on-demand fallback, no backoff, no alert', async () => {
    // Spot takes every instance back before it registers, and refuses launches besides.
    const dry = world({ waiting: 6, boots: () => false, reclaimed: () => true })
    for (let minute = 0; minute < 60; minute++) {
      const { backoff, plan } = await dry.tick(at(minute))
      expect(backoff.backingOff).toBe(false)
      expect(plan.reasons.some(reason => reason.includes('ended without a worker'))).toBe(false)
    }
    expect(dry.alerts).toEqual([])
    expect(dry.launches.length).toBeGreaterThan(6)

    const interrupted = new Map(dry.launches.map(launch => [launch.id, launch.at] as [string, Date]))
    const market = planMarket({ config: group, current: 0, trouble: { refused: [at(58)], interrupted }, now: at(60) })
    expect(market.percent).toBe(100)
  })

  test('a group with backoff turned off never holds back', () => {
    const launches = Array.from({ length: 30 }, (_, index) => ({ id: `i-0dead${index}`, at: at(-index) }))
    expect(planLaunchBackoff({ config: { ...group, launchBackoffSeconds: 0 }, launches, instances: [], registered: [], now: at(5) }).backingOff).toBe(false)
  })
})

describe('what an administrator receives', () => {
  test('HQ\'s group declares its cap', () => {
    expect(group.launchBackoffSeconds).toBe(1800)
  })

  test('email is immediate by default, the inbox says why it arrived', () => {
    expect(defaultDelivery('ops:runner-group', 'email')).toBe('immediate')
    expect(defaultDelivery('ops:runner-group', 'in_app')).toBe('immediate')
    expect(reasonLabel('administrator')).toBe('you administer this instance')
  })

  test('nothing is written or said on a tick that changes nothing', () => {
    const open: BackoffRecord = { died: 7, since: '2026-11-13T21:04:00Z', example: 'i-0a', next_probe_at: '2026-11-13T22:00:00Z', alerted_at: '2026-11-13T21:07:00Z', recovered_at: null }
    const same = { backingOff: true, died: 7, since: new Date('2026-11-13T21:04:00Z'), example: 'i-0a', nextProbeAt: new Date('2026-11-13T22:00:00Z') }
    expect(backoffStep(open, same, at(40))).toEqual({ write: null, tell: null })
    expect(backoffStep(null, { backingOff: false, died: 2, since: at(0), example: 'i-0a', nextProbeAt: null }, at(40))).toEqual({ write: null, tell: null })
    expect(backoffStep({ ...open, recovered_at: '2026-11-14T18:00:00Z' }, { backingOff: false, died: 0, since: null, example: null, nextProbeAt: null }, at(40))).toEqual({ write: null, tell: null })
  })
})
