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
  describeProtocol,
  leaseIsLive,
  leaseUntil,
  mayClaim,
  mayReport,
  negotiate,
  runnerReaches,
  runnerSatisfies,
  RUNNER_PROTOCOL,
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

describe('acknowledging a cancellation', () => {
  /*
   * Cancelling revokes every lease at the moment of the request - that is what
   * stops a worker which already lost its connection publishing a success over
   * a run somebody stopped. The side effect was that the *well-behaved* runner,
   * the one that heard the cancellation, stopped its work and came back to say
   * so, was refused for the same reason as the bad one, and its job sat in
   * `cancelling` until a sweep forced it.
   */
  const asked = (over: Partial<JobFacts> = {}) => job({
    state: 'cancelling',
    runnerId: 1,
    // Revoked: expired the instant the cancellation was requested.
    leaseExpiresAt: new Date(NOW.getTime() - 1000).toISOString(),
    ...over,
  })

  test('is accepted even though the lease was revoked', () => {
    const decision = mayReport(runner({ id: 1 }), asked(), LATER, { reporting: 'cancelled' })

    expect(decision.ok).toBe(true)
    expect(decision.reason).toContain('cancellation')
  })

  /*
   * And only that. "I stopped" cannot fabricate a verdict; "I succeeded" from a
   * revoked lease is exactly the report the revocation exists to refuse, and a
   * green check satisfies a branch protection rule.
   */
  test('but a success on the same revoked lease is not', () => {
    const decision = mayReport(runner({ id: 1 }), asked(), LATER, { reporting: 'succeeded' })

    expect(decision.ok).toBe(false)
    expect(decision.reason).toContain('expired')
  })

  test('nor is an acknowledgement from a runner that never held it', () => {
    const decision = mayReport(runner({ id: 9 }), asked(), LATER, { reporting: 'cancelled' })

    expect(decision.ok).toBe(false)
    expect(decision.reason).toContain('another runner')
  })

  test('a live lease still reports anything it likes', () => {
    // The exception is about the revoked lease, not about `cancelling` being a
    // state where the rules relax.
    const live = asked({ leaseExpiresAt: leaseUntil(NOW) })

    expect(mayReport(runner({ id: 1 }), live, SOON, { reporting: 'succeeded' }).ok).toBe(true)
  })

  test('the old fourth argument still means the terminal-state list', () => {
    // Both call shapes are accepted, so a caller that passed the array does not
    // silently get the default list back - which would change the rule without
    // changing a line.
    const finished = job({ state: 'succeeded', runnerId: 1, leaseExpiresAt: leaseUntil(NOW) })
    const decision = mayReport(runner({ id: 1 }), finished, SOON, ['succeeded'])

    expect(decision.duplicate).toBe(true)
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


describe('speaking the same protocol', () => {
  /*
   * A self-hosted runner is a program somebody else installs, on a machine
   * somebody else reboots, upgraded on a schedule nobody here controls. The two
   * ends drift apart by default; the only question is whether they find out by
   * being told or by behaving strangely - a runner sending a field this server
   * ignores, or reading one it stopped sending, produces a job that hangs
   * rather than an error anybody can act on.
   */
  test('a runner speaking the current version is agreed with', () => {
    expect(negotiate(String(RUNNER_PROTOCOL.current)).ok).toBe(true)
  })

  /*
   * The compatibility rule that matters most on the day it ships. Every runner
   * written before the header existed sends nothing, and refusing those would
   * break every fleet the moment this landed - the opposite of what a
   * compatibility check is for.
   */
  test('a runner that sends no version is assumed to be the oldest, not refused', () => {
    const decision = negotiate('')

    expect(decision.ok).toBe(true)
    expect(decision.version).toBe(RUNNER_PROTOCOL.minimum)
  })

  test('a version this server has retired is refused, and told to upgrade', () => {
    // Against a range with something below it, because there is nothing below
    // 1 yet - and the path that retires a version should be tested before the
    // day somebody retires one.
    const decision = negotiate('1', { minimum: 2, current: 3 })

    expect(decision.ok).toBe(false)
    expect(decision.reason).toContain('upgrade the runner')
  })

  /*
   * Both directions, because a fleet is never upgraded atomically: a runner
   * ahead of its server has to be told rather than left guessing, and the
   * sentence has to say which end is behind - upgrading a hundred machines and
   * upgrading one server are different afternoons.
   */
  test('and a version from the future is refused the other way round', () => {
    const decision = negotiate(String(RUNNER_PROTOCOL.current + 1))

    expect(decision.ok).toBe(false)
    expect(decision.reason).toContain('upgrade the server')
  })

  test('nonsense is refused as nonsense rather than read as a number', () => {
    for (const sent of ['v2', '1.5', '-1', '0', 'latest'])
      expect({ sent, ok: negotiate(sent).ok }).toEqual({ sent, ok: false })
  })

  test('what this server speaks is said in a way an operator can compare', () => {
    // One number when there is one, a range when there are several. A fleet
    // operator upgrading a hundred machines needs one thing to compare against.
    expect(describeProtocol({ minimum: 1, current: 1 })).toBe('1')
    expect(describeProtocol({ minimum: 1, current: 3 })).toBe('1 to 3')
  })
})
