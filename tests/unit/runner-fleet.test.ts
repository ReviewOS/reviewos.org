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
import type { QueueFacts } from '../../app/Actions/Runner/fleet'
import { queueAccepts } from '../../app/Actions/Runner/fleet'

function queue(over: Partial<QueueFacts> = {}): QueueFacts {
  return {
    id: 1,
    name: 'linux-x64-large',
    state: 'active',
    poolId: 1,
    poolName: 'Deployment',
    pausedReason: null,
    repositoryIds: [],
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
