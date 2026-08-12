// Which check results mean "keep sending traffic".
//
// The decision, not the checks. Running them needs a live instance; this is the
// part that decides what happens when one of them is unhappy, and it is the
// part that cannot be exercised safely against a real one - breaking the
// database of the server the suite runs against takes the suite with it.

import { describe, expect, test } from 'bun:test'
import { summarize } from '../../app/Ops/health'

describe('summarize', () => {
  test('all clear is serving', () => {
    expect(summarize([
      { name: 'database', status: 'ok', ms: 3 },
      { name: 'queue', status: 'ok', ms: 4 },
    ]).ok).toBe(true)
  })

  test('a failed subsystem takes the instance out of rotation', () => {
    expect(summarize([
      { name: 'database', status: 'failed', ms: 9, detail: 'connection refused' },
    ]).ok).toBe(false)
  })
})

/**
 * A database clock that is hours out.
 *
 * The failure it stands for is silent and total: `created_at` defaults to
 * `CURRENT_TIMESTAMP`, which is the session's *local* wall clock, and the
 * column carries no time zone - so the offset is dropped on the way in and the
 * value is read back as UTC. Every "3 minutes ago" in the product is then wrong
 * by the host's offset, and wrong times look exactly like times.
 *
 * What is asserted is the *policy*: an instance whose clock is skewed is still
 * serving a working forge, and taking it out of rotation over a display bug
 * would turn it into an outage.
 */
describe('a skewed database clock', () => {
  test('is degraded rather than failed, so the instance keeps serving', () => {
    const report = summarize([
      { name: 'database', status: 'ok', ms: 3 },
      { name: 'database clock', status: 'degraded', ms: 2, detail: 'timestamps are 7.0 hours out' },
      { name: 'queue', status: 'ok', ms: 4 },
    ])

    expect(report.ok).toBe(true)
    expect(report.checks.find(check => check.name === 'database clock')?.status).toBe('degraded')
  })

  test('but it is still reported, rather than swallowed', () => {
    const report = summarize([
      { name: 'database clock', status: 'degraded', ms: 2, detail: 'timestamps are 7.0 hours out' },
    ])

    expect(report.checks[0]?.detail).toContain('7.0 hours')
  })

  test('and a database that is actually gone still takes it out', () => {
    expect(summarize([
      { name: 'database', status: 'failed', ms: 9, detail: 'connection refused' },
      { name: 'database clock', status: 'degraded', ms: 2 },
    ]).ok).toBe(false)
  })
})
