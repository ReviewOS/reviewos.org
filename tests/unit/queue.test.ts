/**
 * The order of the review queue.
 *
 * The ordering is the feature, so it is tested as a value rather than looked at
 * in a browser. Two properties matter more than the exact numbers: the list
 * must be explainable, and it must be stable across two reloads a second apart.
 * A queue that reorders itself by a formula nobody can state is a queue people
 * stop trusting and go back to reading email.
 */

import type { QueueEntry } from '../../app/Actions/Pull/queue'
import { describe, expect, test } from 'bun:test'
import { hoursWaiting, orderQueue, waitingReason, waitingScore } from '../../app/Actions/Pull/queue'

/** A fixed clock. Nothing here reads the real one, so nothing here is flaky. */
const NOW = Date.parse('2026-08-07T12:00:00.000Z')

function hoursAgo(hours: number): string {
  return new Date(NOW - hours * 3_600_000).toISOString()
}

function entry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    pullRequestId: 1,
    number: 1,
    title: 'Something',
    owner: 'someone',
    repository: 'repo',
    authorHandle: 'author',
    waitingSince: hoursAgo(1),
    draft: false,
    outstandingReviewers: 2,
    approvals: 0,
    ...overrides,
  }
}

describe('hoursWaiting', () => {
  test('counts the hours since the request', () => {
    expect(hoursWaiting(entry({ waitingSince: hoursAgo(30) }), NOW)).toBeCloseTo(30, 5)
  })

  /**
   * A clock skew between the database and the process would otherwise put a
   * fresh request above a week-old one, which is the single most confusing
   * thing a queue can do.
   */
  test('a timestamp in the future is not negative age', () => {
    expect(hoursWaiting(entry({ waitingSince: hoursAgo(-5) }), NOW)).toBe(0)
  })

  test('an unparseable timestamp is no age rather than a crash', () => {
    expect(hoursWaiting(entry({ waitingSince: 'not a date' }), NOW)).toBe(0)
  })
})

describe('waitingScore', () => {
  test('older waits more than newer', () => {
    expect(waitingScore(entry({ waitingSince: hoursAgo(48) }), NOW))
      .toBeGreaterThan(waitingScore(entry({ waitingSince: hoursAgo(2) }), NOW))
  })

  /**
   * Somebody who has not marked their work ready has not asked. A draft ageing
   * its way to the top is how a queue teaches people to ignore it.
   */
  test('a draft sorts below everything, however old', () => {
    const ancient = entry({ waitingSince: hoursAgo(1000), draft: true })
    const fresh = entry({ waitingSince: hoursAgo(0.1) })

    expect(waitingScore(ancient, NOW)).toBeLessThan(waitingScore(fresh, NOW))
  })

  test('being the only reviewer asked counts double', () => {
    const alone = entry({ waitingSince: hoursAgo(10), outstandingReviewers: 1 })
    const crowd = entry({ waitingSince: hoursAgo(10), outstandingReviewers: 4 })

    expect(waitingScore(alone, NOW)).toBe(waitingScore(crowd, NOW) * 2)
  })

  /**
   * The pull request can move without you now, so your answer is worth having
   * and is no longer the thing in the way.
   */
  test('an approval already in halves it', () => {
    const blocked = entry({ waitingSince: hoursAgo(10) })
    const moving = entry({ waitingSince: hoursAgo(10), approvals: 1 })

    expect(waitingScore(moving, NOW)).toBe(waitingScore(blocked, NOW) / 2)
  })
})

describe('orderQueue', () => {
  test('the most blocked thing is first', () => {
    const ordered = orderQueue([
      entry({ number: 1, waitingSince: hoursAgo(2), outstandingReviewers: 3 }),
      entry({ number: 2, waitingSince: hoursAgo(50), outstandingReviewers: 1 }),
      entry({ number: 3, waitingSince: hoursAgo(10), outstandingReviewers: 3 }),
    ], NOW)

    expect(ordered.map(one => one.number)).toEqual([2, 3, 1])
  })

  test('drafts land at the bottom, in their own order', () => {
    const ordered = orderQueue([
      entry({ number: 1, waitingSince: hoursAgo(1000), draft: true }),
      entry({ number: 2, waitingSince: hoursAgo(1) }),
    ], NOW)

    expect(ordered.map(one => one.number)).toEqual([2, 1])
  })

  /**
   * Two reloads a second apart must produce the same list. The tie-break is the
   * pull request's own number, which never changes, rather than anything
   * derived from the clock or from the order rows came back in.
   */
  test('two entries that score the same always come back in the same order', () => {
    const same = { waitingSince: hoursAgo(5), outstandingReviewers: 2 }
    const forwards = orderQueue([entry({ number: 9, ...same }), entry({ number: 4, ...same })], NOW)
    const backwards = orderQueue([entry({ number: 4, ...same }), entry({ number: 9, ...same })], NOW)

    expect(forwards.map(one => one.number)).toEqual([4, 9])
    expect(backwards.map(one => one.number)).toEqual([4, 9])
  })

  test('sorts a copy, so the caller keeps their array', () => {
    const given = [entry({ number: 1, waitingSince: hoursAgo(1) }), entry({ number: 2, waitingSince: hoursAgo(90) })]
    orderQueue(given, NOW)

    expect(given.map(one => one.number)).toEqual([1, 2])
  })

  test('an empty queue is an empty list', () => {
    expect(orderQueue([], NOW)).toEqual([])
  })
})

describe('waitingReason', () => {
  test('says why an entry is where it is, in a phrase', () => {
    expect(waitingReason(entry({ waitingSince: hoursAgo(50), outstandingReviewers: 1 }), NOW))
      .toBe('2d, only you')
    expect(waitingReason(entry({ waitingSince: hoursAgo(5), outstandingReviewers: 3 }), NOW))
      .toBe('5h, 3 asked')
    expect(waitingReason(entry({ waitingSince: hoursAgo(5), approvals: 2 }), NOW))
      .toBe('5h, already approved by somebody')
    expect(waitingReason(entry({ draft: true }), NOW)).toBe('draft, not asking yet')
  })

  test('something asked for a moment ago says so rather than "0h"', () => {
    expect(waitingReason(entry({ waitingSince: hoursAgo(0.2) }), NOW)).toContain('just now')
  })
})
