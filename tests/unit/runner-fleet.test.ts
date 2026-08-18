// Pools and queues: which machines may take which repository's work.
//
// A list of runners is enough for one team on one box. It stops being enough
// the moment a fleet has machines bought for different reasons - a runner
// standing up the deployment pipeline, holding the credentials that pipeline
// needs, will take a pull request check from an unrelated repository, and the
// only thing between them is whichever labels somebody remembered to write.
//
// The rules are here rather than in SQL because the claim and the run page's
// "why is this queued" both ask them, and two implementations of a boundary is
// one that eventually leaks.

import { describe, expect, test } from 'bun:test'
import type { QueueFacts, RunnerObservation } from '../../app/Actions/Runner/fleet'
import { queueAccepts, runnerLifecycle } from '../../app/Actions/Runner/fleet'

function queue(over: Partial<QueueFacts> = {}): QueueFacts {
  return {
    id: 1,
    name: 'linux-x64-large',
    state: 'active',
    poolId: 1,
    poolName: 'Deployment',
    pausedReason: null,
    repositoryIds: [],
    requireSignedSteps: false,
    ...over,
  }
}

describe('a runner in no queue', () => {
  test('is not asking the question at all', () => {
    /*
     * The compatibility rule the whole design rests on: an instance that never
     * opens the fleet screen behaves exactly as it did, matched by label and
     * scope alone.
     */
    expect(queueAccepts(null, 7)).toEqual({ ok: true })
  })
})

describe('an unrestricted pool', () => {
  test('serves every repository, which is what an empty list means', () => {
    // Backwards until you consider which way an operator would rather be
    // wrong: a pool that silently served nothing would take a fleet offline
    // the moment somebody created it.
    expect(queueAccepts(queue({ repositoryIds: [] }), 7)).toEqual({ ok: true })
  })
})

describe('a pool with a list', () => {
  test('serves what it lists', () => {
    expect(queueAccepts(queue({ repositoryIds: [7, 9] }), 7)).toEqual({ ok: true })
  })

  test('and refuses what it does not, by name', () => {
    const verdict = queueAccepts(queue({ repositoryIds: [9] }), 7)

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.kind).toBe('pool-refuses')
    expect(verdict.ok === false && verdict.reason).toContain('Deployment')
  })

  test('without naming the other repositories it serves', () => {
    /*
     * Somebody looking at one repository's run has no business learning which
     * other repositories a pool serves. On a shared instance that list is the
     * map of who is working on what.
     */
    const verdict = queueAccepts(queue({ repositoryIds: [11, 12, 13] }), 7)

    expect(verdict.ok === false && verdict.reason).not.toContain('11')
  })
})

describe('a paused queue', () => {
  test('hands out nothing, and says so', () => {
    const verdict = queueAccepts(queue({ state: 'paused' }), 7)

    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.kind).toBe('queue-paused')
    expect(verdict.ok === false && verdict.reason).toContain('linux-x64-large')
  })

  test('and carries the operator\'s reason when there is one', () => {
    // The person who comes back to a stuck queue is usually not the person who
    // drained it.
    const verdict = queueAccepts(queue({ state: 'paused', pausedReason: 'kernel upgrade' }), 7)

    expect(verdict.ok === false && verdict.reason).toContain('kernel upgrade')
  })

  test('even for a repository the pool serves', () => {
    // Draining beats permission: a queue that is paused is paused for
    // everybody, which is the whole point of taking machines out of service.
    expect(queueAccepts(queue({ state: 'paused', repositoryIds: [7] }), 7).ok).toBe(false)
  })
})

/*
 * What a runner is *doing*, as opposed to what an operator set it to.
 *
 * `state` is administrative and answers the wrong question when a fleet is
 * misbehaving. The question is which machines are working, which are sitting
 * there, and which have gone quiet - and the last one is the only state nobody
 * sets, which is exactly why it has to be derived rather than stored.
 */
describe('what a runner is doing', () => {
  const now = new Date('2026-03-04T12:00:00.000Z')

  function seen(secondsAgo: number): string {
    return new Date(now.getTime() - secondsAgo * 1000).toISOString()
  }

  function observation(over: Partial<RunnerObservation> = {}): RunnerObservation {
    return {
      state: 'active',
      lastSeenAt: seen(5),
      stopRequested: null,
      holdsJob: false,
      leaseLapsed: false,
      ...over,
    }
  }

  test('polling with nothing to do is idle', () => {
    expect(runnerLifecycle(observation(), now)).toBe('idle')
  })

  test('holding a job is running', () => {
    expect(runnerLifecycle(observation({ holdsJob: true }), now)).toBe('running')
  })

  test('a credential nobody has used says so, rather than looking idle', () => {
    // The commonest first-run confusion: a runner was registered, the command
    // was never started, and the fleet screen shows a machine that is fine.
    expect(runnerLifecycle(observation({ lastSeenAt: null }), now)).toBe('never-seen')
  })

  test('switched off outranks everything', () => {
    expect(runnerLifecycle(observation({ state: 'disabled', holdsJob: true }), now)).toBe('disabled')
  })

  test('asked to stop, still holding, is stopping', () => {
    expect(runnerLifecycle(observation({ stopRequested: 'graceful', holdsJob: true }), now)).toBe('stopping')
  })

  test('and a machine that went quiet is lost, whatever it was doing', () => {
    /*
     * Lost outranks stopping and running because it is the one that is not
     * true by assumption: a machine asked to stop that then goes quiet has
     * stopped without saying so.
     */
    expect(runnerLifecycle(observation({ lastSeenAt: seen(600) }), now)).toBe('lost')
    expect(runnerLifecycle(observation({ lastSeenAt: seen(600), stopRequested: 'graceful' }), now)).toBe('lost')
    expect(runnerLifecycle(observation({ holdsJob: true, leaseLapsed: true }), now)).toBe('lost')
  })
})
