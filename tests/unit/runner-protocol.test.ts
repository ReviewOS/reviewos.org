// Who may take a job, and whose word about it counts.
//
// The cases below are the ones the roadmap asks a fake provider to produce -
// disconnect, duplicate claim, late completion, a credential used against the
// wrong job - and none of them are convenient to make happen with a real
// runner. All of them will happen: a runner is somebody else's machine on
// somebody else's network, and network partitions are not rare events.
//
// Every one of them has the same worst outcome, which is why they are tested
// together: a job's answer changed by a machine that had no right to change it.

import { describe, expect, test } from 'bun:test'
import type { JobFacts, RunnerFacts } from '../../app/Actions/Runner/protocol'
import {
  leaseIsLive,
  leaseUntil,
  mayClaim,
  mayReport,
  runnerReaches,
  runnerSatisfies,
  splitLabels,
} from '../../app/Actions/Runner/protocol'

const NOW = new Date('2026-08-11T12:00:00.000Z')
const SOON = new Date('2026-08-11T12:00:30.000Z')
const LATER = new Date('2026-08-11T12:05:00.000Z')

function runner(over: Partial<RunnerFacts> = {}): RunnerFacts {
  return {
    id: 1,
    state: 'active',
    scopeType: 'instance',
    scopeId: null,
    labels: ['ubuntu-latest', 'self-hosted'],
    ...over,
  }
}

function job(over: Partial<JobFacts> = {}): JobFacts {
  return {
    id: 10,
    state: 'queued',
    runsOn: ['ubuntu-latest'],
    repositoryId: 100,
    ownerId: 200,
    runnerId: null,
    leaseExpiresAt: null,
    ...over,
  }
}

describe('reach', () => {
  test('an instance runner sees everything', () => {
    expect(runnerReaches(runner(), job())).toBe(true)
  })

  test('an organization runner sees its own owner and no other', () => {
    const scoped = runner({ scopeType: 'organization', scopeId: 200 })

    expect(runnerReaches(scoped, job({ ownerId: 200 }))).toBe(true)
    expect(runnerReaches(scoped, job({ ownerId: 201 }))).toBe(false)
  })

  /*
   * The one that is not a scheduling mistake. A runner registered for one
   * repository being handed another's source is the instance giving somebody
   * else's private code to a machine its owner chose.
   */
  test('a repository runner is not offered another repository', () => {
    const scoped = runner({ scopeType: 'repository', scopeId: 100 })

    expect(runnerReaches(scoped, job({ repositoryId: 100 }))).toBe(true)
    expect(runnerReaches(scoped, job({ repositoryId: 101 }))).toBe(false)
  })

  // A scope this code does not understand must not default to everything: that
  // is the direction that leaks, and a scope added later would do it silently.
  test('an unknown scope reaches nothing', () => {
    expect(runnerReaches(runner({ scopeType: 'galaxy', scopeId: 1 }), job())).toBe(false)
  })
})

describe('labels', () => {
  test('a runner needs every label the job asks for, not one of them', () => {
    const asked = job({ runsOn: ['self-hosted', 'macos'] })

    expect(runnerSatisfies(runner({ labels: ['self-hosted'] }), asked)).toBe(false)
    expect(runnerSatisfies(runner({ labels: ['self-hosted', 'macos'] }), asked)).toBe(true)
  })

  test('a job that asks for nothing runs anywhere', () => {
    expect(runnerSatisfies(runner({ labels: [] }), job({ runsOn: [] }))).toBe(true)
  })

  test('matching ignores case, because nobody is consistent about it', () => {
    expect(runnerSatisfies(runner({ labels: ['Ubuntu-Latest'] }), job({ runsOn: ['ubuntu-latest'] }))).toBe(true)
  })
})

describe('claiming', () => {
  test('a queued job goes to a runner that fits', () => {
    expect(mayClaim(runner(), job(), NOW).ok).toBe(true)
  })

  test('a disabled runner takes nothing', () => {
    const decision = mayClaim(runner({ state: 'disabled' }), job(), NOW)

    expect(decision.ok).toBe(false)
    expect(decision.reason).toContain('disabled')
  })

  test('a runner without the labels is told which ones', () => {
    const decision = mayClaim(runner({ labels: ['windows'] }), job({ runsOn: ['ubuntu-latest'] }), NOW)

    expect(decision.ok).toBe(false)
    expect(decision.reason).toContain('ubuntu-latest')
  })

  /*
   * The duplicate claim. Two runners polling at the same moment, or one runner
   * asking twice because it did not hear the first answer.
   */
  test('a job somebody else holds is not claimable while their lease is live', () => {
    const held = job({ state: 'running', runnerId: 2, leaseExpiresAt: leaseUntil(NOW) })

    const decision = mayClaim(runner({ id: 1 }), held, SOON)
    expect(decision.ok).toBe(false)
    expect(decision.reason).toContain('another runner')
  })

  /*
   * And the recovery. A runner that died cannot say so, so the only thing that
   * frees its work is the lease lapsing - otherwise a machine falling over
   * strands a job until a person notices.
   */
  test('but is claimable once that lease has expired', () => {
    const stale = job({ state: 'running', runnerId: 2, leaseExpiresAt: leaseUntil(NOW) })

    const decision = mayClaim(runner({ id: 1 }), stale, LATER)
    expect(decision.ok).toBe(true)
    expect(decision.reason).toContain('expired')
  })

  test('a finished job is not handed out again', () => {
    for (const state of ['succeeded', 'failed', 'cancelled', 'skipped']) {
      expect(mayClaim(runner(), job({ state }), NOW).ok).toBe(false)
    }
  })

  test('a blocked job is not available, because its dependencies have not run', () => {
    expect(mayClaim(runner(), job({ state: 'blocked' }), NOW).ok).toBe(false)
  })
})

describe('reporting', () => {
  const held = (over: Partial<JobFacts> = {}) => job({
    state: 'running',
    runnerId: 1,
    leaseExpiresAt: leaseUntil(NOW),
    ...over,
  })

  test('the lease holder, in time, is believed', () => {
    expect(mayReport(runner({ id: 1 }), held(), SOON).ok).toBe(true)
  })

  /*
   * The one this rule exists for. A worker that lost its connection is
   * indistinguishable from one that never left, except by the lease - and
   * without this it can publish a success over a job that was cancelled and
   * handed to somebody else. That is a green check for work nobody did.
   */
  test('a report after the lease lapsed is refused', () => {
    const decision = mayReport(runner({ id: 1 }), held(), LATER)

    expect(decision.ok).toBe(false)
    expect(decision.reason).toContain('expired')
  })

  test('a runner reporting on a job it does not hold is refused', () => {
    const decision = mayReport(runner({ id: 9 }), held(), SOON)

    expect(decision.ok).toBe(false)
    expect(decision.reason).toContain('another runner')
  })

  test('a report on a job nobody holds is refused', () => {
    const decision = mayReport(runner({ id: 1 }), job({ runnerId: null }), SOON)

    expect(decision.ok).toBe(false)
    expect(decision.reason).toContain('not held')
  })

  /*
   * Delivery is at-least-once, so a runner that did not hear the answer says it
   * again. The repeat is answered as though it worked, because from the
   * runner's side it did - treating it as a conflict is how a correct runner
   * ends up retrying forever.
   */
  test('a repeat of a completion already recorded is accepted as a duplicate', () => {
    const done = held({ state: 'succeeded' })
    const decision = mayReport(runner({ id: 1 }), done, SOON)

    expect(decision.ok).toBe(true)
    expect(decision.duplicate).toBe(true)
  })

  test('and a duplicate is still refused when it comes from the wrong runner', () => {
    const decision = mayReport(runner({ id: 9 }), held({ state: 'succeeded' }), SOON)

    expect(decision.ok).toBe(false)
    expect(decision.duplicate).toBe(false)
  })
})

describe('leases', () => {
  test('a lease is live until it is not', () => {
    const holding = job({ leaseExpiresAt: leaseUntil(NOW) })

    expect(leaseIsLive(holding, SOON)).toBe(true)
    expect(leaseIsLive(holding, LATER)).toBe(false)
  })

  test('no lease is not a live lease', () => {
    expect(leaseIsLive(job({ leaseExpiresAt: null }), NOW)).toBe(false)
  })

  // A malformed timestamp must read as expired rather than as forever. The
  // other way round, one bad write holds a job for good.
  test('an unparseable lease is treated as expired', () => {
    expect(leaseIsLive(job({ leaseExpiresAt: 'soon-ish' }), NOW)).toBe(false)
  })
})

describe('splitLabels', () => {
  test('reads one per line and ignores the blanks', () => {
    expect(splitLabels('ubuntu-latest\n\n  self-hosted  \n')).toEqual(['ubuntu-latest', 'self-hosted'])
  })

  test('and absent is no labels rather than one empty one', () => {
    expect(splitLabels(null)).toEqual([])
    expect(splitLabels('   ')).toEqual([])
  })
})
