// When the token being replaced stops working.
//
// The arithmetic is small and the consequences are not: this decides whether a
// rotation leaves a gap (the thing the feature exists to remove), whether it
// hands a revoked token's grants back, and whether repeated rotation is a way
// to outlive the maximum lifetime.

import { describe, expect, test } from 'bun:test'
import { planRotation, ROTATION_OVERLAP_MS } from '../../app/Actions/Tokens/rotate'

const NOW = Date.parse('2026-08-08T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

describe('planRotation', () => {
  test('leaves an active token working for the overlap', () => {
    const plan = planRotation({ state: 'active', expiresAtMs: NOW + 60 * DAY, nowMs: NOW })

    expect(plan).toEqual({ ok: true, oldExpiresAtMs: NOW + ROTATION_OVERLAP_MS })
  })

  test('the overlap survives a weekend', () => {
    // A day is the shortest window that lets somebody rotate on a Friday and
    // deploy on Monday without anything breaking in between. Asserted as a
    // property rather than a constant, so shortening it fails here loudly.
    expect(ROTATION_OVERLAP_MS).toBeGreaterThanOrEqual(DAY)
  })

  test('never extends a token past the expiry it already had', () => {
    // Four hours left. Rotating must not buy it another twenty.
    const soon = NOW + 4 * 60 * 60 * 1000
    const plan = planRotation({ state: 'active', expiresAtMs: soon, nowMs: NOW })

    expect(plan).toEqual({ ok: true, oldExpiresAtMs: soon })
  })

  test('so rotating in a loop cannot outlive the maximum lifetime', () => {
    // The hole every "just extend it" feature turns out to have: if each
    // rotation moved the old token's expiry forward, a script rotating daily
    // would keep one token alive indefinitely. Walk it and check it only ever
    // moves closer.
    let expiresAt = NOW + 3 * 60 * 60 * 1000
    let now = NOW

    for (let round = 0; round < 5; round++) {
      const plan = planRotation({ state: 'active', expiresAtMs: expiresAt, nowMs: now })
      expect(plan.ok).toBe(true)
      if (!plan.ok)
        return

      expect(plan.oldExpiresAtMs).toBeLessThanOrEqual(expiresAt)
      expiresAt = plan.oldExpiresAtMs
      now += 60 * 60 * 1000
    }

    expect(expiresAt).toBe(NOW + 3 * 60 * 60 * 1000)
  })

  test('refuses a revoked token, and says to issue a new one', () => {
    const plan = planRotation({ state: 'revoked', expiresAtMs: NOW + 60 * DAY, nowMs: NOW })

    expect(plan.ok).toBe(false)
    if (plan.ok)
      return

    // Revocation has to be final or it is not revocation. Somebody who stopped
    // a leaked token must not be able to hand its grants back with one call,
    // and neither must whoever took the account afterwards.
    expect(plan.status).toBe(409)
    expect(plan.error).toContain('revoked')
  })

  test('rotates an expired token, because lapsing was not a decision', () => {
    // Expiry is what rotation is for. Refusing here would mean the one moment
    // somebody reaches for this is the one moment it does not work.
    const plan = planRotation({ state: 'expired', expiresAtMs: NOW - DAY, nowMs: NOW })

    // No overlap to give: it stopped working before the request arrived.
    expect(plan).toEqual({ ok: true, oldExpiresAtMs: NOW })
  })

  test('honours a shorter overlap when one is asked for', () => {
    const plan = planRotation({
      state: 'active',
      expiresAtMs: NOW + 60 * DAY,
      nowMs: NOW,
      overlapMs: 60 * 60 * 1000,
    })

    expect(plan).toEqual({ ok: true, oldExpiresAtMs: NOW + 60 * 60 * 1000 })
  })
})
