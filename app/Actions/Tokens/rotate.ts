/**
 * Replacing a token without a gap.
 *
 * The reason this exists is the reason people set no expiry at all. Rotating by
 * hand means issuing a new token, deploying it, and revoking the old one - and
 * between the second and third step somebody has to remember. If instead they
 * revoke first, everything that used the old one is broken until the deploy
 * lands, at whatever hour they noticed. Both roads end at a token nobody ever
 * rotates.
 *
 * So rotation issues the replacement and leaves the old one working for a short
 * while. The overlap is the whole feature: it is the window in which both
 * tokens answer, so the deploy can happen at a normal time on a normal day.
 *
 * **A revoked token is not rotatable.** Revocation has to be final or it is not
 * revocation: somebody who stopped a leaked token must not be able to hand its
 * grants back with one call, and neither must anybody who got hold of the
 * account afterwards. An expired one is different - lapsing is not a decision -
 * and rotating it is exactly the fix, so that is allowed.
 */

import type { TokenState } from '../../TokenScopes'

/**
 * How long the old token keeps working.
 *
 * A day, which is the shortest window that survives a working week: rotate on
 * a Friday afternoon and the deploy can still be Monday morning. Shorter and
 * this recreates the problem it exists to solve; much longer and a rotation
 * stops meaning anything, because the token being replaced is still live for
 * long enough to be the one that leaks.
 */
export const ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000

export type RotationRefusal
  = | { ok: false, status: number, error: string }

export type RotationPlan
  = | { ok: true, oldExpiresAtMs: number }
    | RotationRefusal

/**
 * When the token being replaced should stop working.
 *
 * Never later than it already would. A token four hours from expiry does not
 * get its life extended by being rotated - that would make rotation a way to
 * quietly outlive the maximum lifetime, one rotation at a time, which is the
 * hole every "just extend it" feature turns out to have.
 */
export function planRotation(input: {
  state: TokenState
  expiresAtMs: number | null
  nowMs: number
  overlapMs?: number
}): RotationPlan {
  const { state, expiresAtMs, nowMs, overlapMs = ROTATION_OVERLAP_MS } = input

  if (state === 'revoked') {
    return {
      ok: false,
      status: 409,
      error: 'That token was revoked, and a revoked token cannot be rotated. Issue a new one instead.',
    }
  }

  // An expired token has no overlap to give - it stopped working already - so
  // the replacement simply starts. Returning `nowMs` rather than the old expiry
  // keeps the caller from having to special-case it.
  if (state === 'expired')
    return { ok: true, oldExpiresAtMs: nowMs }

  const overlapEnds = nowMs + overlapMs

  return {
    ok: true,
    oldExpiresAtMs: expiresAtMs === null ? overlapEnds : Math.min(expiresAtMs, overlapEnds),
  }
}
