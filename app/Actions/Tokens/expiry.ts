/**
 * Telling somebody a token is about to stop working.
 *
 * This is the other half of refusing to offer an unlimited expiry. That refusal
 * is right - a token that never expires is one nobody ever revisits - but on
 * its own it teaches the opposite lesson: a build that breaks at 02:00 because
 * a token lapsed silently is an argument for setting the longest expiry the
 * instance allows, every time, and never thinking about it again. The warning
 * is what makes the expiry a deadline somebody can act on rather than an
 * ambush.
 *
 * Two warnings, not one. Seven days is enough time to rotate during a working
 * week; one day is the reminder for whoever read the first mail on a Friday and
 * meant to do it Monday. Beyond two, the warnings become the noise people
 * filter, and a filtered warning is worse than none because it also hides the
 * next one.
 */

import type { TokenState } from '../../TokenScopes'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How many days out each warning goes.
 *
 * Narrowest first, and the order is load-bearing. A token half a day from
 * expiring is inside *both* windows, and the one it should be reported against
 * is the tighter one - checking widest first finds the seven-day threshold,
 * sees that seven-day warning already went, and concludes there is nothing to
 * send. The reader then never hears the last notice, which is the one they
 * would have acted on.
 */
export const WARNING_THRESHOLDS_DAYS: readonly number[] = [1, 7]

export interface WarnableToken {
  state: TokenState
  expiresAtMs: number | null
  /** The narrowest warning already sent, in days, or null. */
  warnedDays: number | null
}

export type WarningDecision
  = | { warn: true, thresholdDays: number, daysLeft: number }
    | { warn: false, reason: 'not-active' | 'no-expiry' | 'too-far-out' | 'already-warned' }

/**
 * Whether this token is due a warning, and which one.
 *
 * Pure, and takes the clock, because everything that makes this correct is a
 * boundary: the day it crosses each threshold, the day it has already been
 * told, and the moment it is too late to be worth telling anyone.
 */
export function warningFor(token: WarnableToken, nowMs: number): WarningDecision {
  // A revoked or already-expired token has nothing to warn about. Mailing
  // somebody about a token that stopped working yesterday is a notification
  // that can only annoy: there is no action left that the mail is asking for.
  if (token.state !== 'active')
    return { warn: false, reason: 'not-active' }

  if (token.expiresAtMs === null)
    return { warn: false, reason: 'no-expiry' }

  const msLeft = token.expiresAtMs - nowMs
  if (msLeft <= 0)
    return { warn: false, reason: 'not-active' }

  const daysLeft = msLeft / DAY_MS

  // Narrowest first: the token is reported against the tightest window it is
  // inside, so a second and more urgent warning can follow the first.
  for (const threshold of WARNING_THRESHOLDS_DAYS) {
    if (daysLeft > threshold)
      continue

    // Inside this window. Only send if nothing narrower or equal has gone
    // already, which is what stops an hourly sweep sending the same warning
    // every hour for seven days.
    if (token.warnedDays !== null && token.warnedDays <= threshold)
      return { warn: false, reason: 'already-warned' }

    return { warn: true, thresholdDays: threshold, daysLeft }
  }

  return { warn: false, reason: 'too-far-out' }
}

/**
 * How the deadline is said in the subject line.
 *
 * Days rather than a timestamp, because the reader is deciding whether this is
 * today's problem. "expires in 6 days" answers that; "expires 2026-08-14T09:13Z"
 * makes them work it out, and they will not.
 */
export function describeDeadline(daysLeft: number): string {
  if (daysLeft < 1) {
    const hours = Math.max(1, Math.round(daysLeft * 24))

    return hours === 1 ? 'in about an hour' : `in about ${hours} hours`
  }

  const days = Math.round(daysLeft)

  return days === 1 ? 'tomorrow' : `in ${days} days`
}

/**
 * The furthest-out threshold, for the sweep's query.
 *
 * The sweep should not read every token on the instance to find the few that
 * are close. This is the widest window worth loading, so the query can bound
 * itself in SQL and `warningFor` decides the rest.
 */
export function widestWindowMs(): number {
  return Math.max(...WARNING_THRESHOLDS_DAYS) * DAY_MS
}
