// The merge queue's rules.
//
// "Green on my branch" and "green after everything ahead of me lands" are
// different questions, and only the second decides whether main works. Two pull
// requests that each pass alone and break together are the ordinary case - a
// renamed function and a new caller of it will do it - so a forge that merges
// on the first answer breaks main regularly and blames whoever pushed last.
//
// Every rule here is pure, because each is one somebody will read off a queue
// screen and check against what actually happened.

import { describe, expect, test } from 'bun:test'
import { baseFor, ejectFailure, nextPosition, nextToTest, stalled } from '../../app/Actions/Pull/mergeQueue'

function entry(over: Partial<any> = {}): any {
  return { id: 1, pullRequestId: 10, position: 1, state: 'queued', mergeSha: '', ...over }
}

describe('what is tested next', () => {
  test('the lowest position still waiting', () => {
    const next = nextToTest([
      entry({ id: 2, position: 2 }),
      entry({ id: 1, position: 1 }),
    ])

    expect(next?.id).toBe(1)
  })

  test('and nothing while something is being tested', () => {
    /*
     * Speculative parallel testing is possible and deliberately not done:
     * it doubles the machine cost to save latency, and paying for that before
     * anybody has asked is paying for a problem this instance does not have.
     */
    expect(nextToTest([entry({ id: 1, state: 'testing' }), entry({ id: 2, position: 2 })])).toBeNull()
  })

  test('an empty queue has nothing to do', () => {
    expect(nextToTest([])).toBeNull()
  })
})

describe('where a new entry goes', () => {
  test('the end, always', () => {
    // A queue with a priority lane is one where the important change waits
    // behind three important changes, and "important" is decided by whoever is
    // most annoyed.
    expect(nextPosition([entry({ position: 1 }), entry({ position: 7 })])).toBe(8)
    expect(nextPosition([])).toBe(1)
  })
})

describe('what an entry is tested on', () => {
  test('the tip, when it is first', () => {
    expect(baseFor([entry({ id: 1, position: 1 })], entry({ id: 1, position: 1 }), 'tipsha')).toBe('tipsha')
  })

  test('and the prospective result of the one ahead, when there is one', () => {
    /*
     * The speculative part, and the reason a queue is faster than merging one
     * at a time: entry three is tested on top of one and two as though they had
     * landed.
     */
    const entries = [
      entry({ id: 1, position: 1, mergeSha: 'aaa', state: 'testing' }),
      entry({ id: 2, position: 2, mergeSha: 'bbb', state: 'queued' }),
      entry({ id: 3, position: 3 }),
    ]

    expect(baseFor(entries, entries[2], 'tipsha')).toBe('bbb')
  })

  test('and an ejected entry ahead is not a base to build on', () => {
    const entries = [
      entry({ id: 1, position: 1, mergeSha: 'aaa', state: 'ejected' }),
      entry({ id: 2, position: 2 }),
    ]

    expect(baseFor(entries, entries[1], 'tipsha')).toBe('tipsha')
  })
})

describe('a failure', () => {
  test('takes the entry out and sends everything behind it back', () => {
    /*
     * The rule that makes the queue worth having. Everything behind a failure
     * was tested on top of a commit that is not going to exist, so its green is
     * about a history nobody will have - and not re-testing is how a merge
     * queue lands the thing that breaks main.
     */
    const entries = [
      entry({ id: 1, position: 1, state: 'testing' }),
      entry({ id: 2, position: 2 }),
      entry({ id: 3, position: 3 }),
    ]

    const outcome = ejectFailure(entries, entries[0])

    expect(outcome.ejected.id).toBe(1)
    expect(outcome.requeue.map((one: any) => one.id)).toEqual([2, 3])
  })

  test('and leaves entries ahead of it alone', () => {
    const entries = [
      entry({ id: 1, position: 1, state: 'merged' }),
      entry({ id: 2, position: 2, state: 'testing' }),
      entry({ id: 3, position: 3 }),
    ]

    expect(ejectFailure(entries, entries[1]).requeue.map((one: any) => one.id)).toEqual([3])
  })

  test('positions are kept, so the order people were told is the order that happens', () => {
    const entries = [entry({ id: 1, position: 1, state: 'testing' }), entry({ id: 2, position: 2 })]

    expect(ejectFailure(entries, entries[0]).requeue[0].position).toBe(2)
  })
})

describe('a queue that is stuck rather than busy', () => {
  test('is an entry testing since before the cutoff', () => {
    /*
     * A run that died without reporting leaves the whole queue waiting on a
     * machine that is never coming back. Reported as an observation rather than
     * acted on here: what to do about it is a policy.
     */
    const entries = [entry({ id: 1, state: 'testing' }), entry({ id: 2, position: 2 })]
    const started = new Map([[1, new Date('2026-03-01T10:00:00Z')]])

    expect(stalled(entries, started, new Date('2026-03-01T12:00:00Z')).map((one: any) => one.id)).toEqual([1])
    expect(stalled(entries, started, new Date('2026-03-01T09:00:00Z'))).toEqual([])
  })
})
