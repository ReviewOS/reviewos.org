/**
 * Reading somebody's notification settings and answering the delivery question.
 *
 * This is the impure half: `delivery.ts` holds the rules and `clock.ts` holds
 * the calendar, and neither touches the database. Everything that sends a
 * notification comes through `deliveryFor` so that every channel asks the same
 * question and gets the same answer, which is the only way the interface can
 * honestly tell someone what would happen to a review request right now.
 */

import type { Channel, DeliveryOutcome, Schedule } from './delivery'
import { localTimeIn, parseDays, parseEventList } from './clock'
import { deliveryDecision, muteApplies } from './delivery'

export type SubjectType = 'repository' | 'organization' | 'issue' | 'pull_request'

export interface Subject {
  type: SubjectType
  id: number
}

export interface DeliveryQuery {
  userId: number
  channel: Channel
  /** The event type, checked against the recipient's break-through list. */
  event: string
  /**
   * The subject, and anything it sits inside. A pull request in a muted
   * repository is muted, so the caller passes both and the widest mute wins.
   */
  subjects: readonly Subject[]
  /** Passed in rather than read from the clock, so callers can be tested. */
  nowMs: number
}

/**
 * What would happen to this notification, right now.
 *
 * A missing schedule row is not an error: most people never set one, and the
 * absence means unconstrained rather than silent.
 */
export async function deliveryFor(query: DeliveryQuery): Promise<DeliveryOutcome> {
  const row = await db
    .selectFrom('notification_schedules')
    .select(['days', 'starts_at', 'ends_at', 'timezone', 'breaks_through', 'do_not_disturb_until'])
    .where('user_id', '=', query.userId)
    .executeTakeFirst()

  const timezone = String(row?.timezone ?? 'UTC')

  const schedule: Schedule | null = row
    ? {
        days: parseDays(String(row.days ?? '')),
        startsAt: Number(row.starts_at ?? 0),
        endsAt: Number(row.ends_at ?? 0),
      }
    : null

  const doNotDisturbUntil = row?.do_not_disturb_until
    ? Date.parse(String(row.do_not_disturb_until))
    : null

  return deliveryDecision({
    channel: query.channel,
    now: localTimeIn(timezone, query.nowMs),
    schedule,
    muted: await isMuted(query.userId, query.subjects, query.nowMs),
    doNotDisturbUntilMs: Number.isNaN(doNotDisturbUntil) ? null : doNotDisturbUntil,
    breaksThrough: parseEventList(String(row?.breaks_through ?? '')).includes(query.event),
  })
}

/**
 * Whether any of the subjects this notification belongs to is muted.
 *
 * Checked widest-first in effect rather than in order: a pull request inside a
 * muted repository is muted, and muting the repository is the action people
 * actually take.
 */
export async function isMuted(
  userId: number,
  subjects: readonly Subject[],
  nowMs: number,
): Promise<boolean> {
  if (subjects.length === 0)
    return false

  const rows = await db
    .selectFrom('notification_mutes')
    .select(['subject_type', 'subject_id', 'expires_at'])
    .where('user_id', '=', userId)
    .execute()

  for (const subject of subjects) {
    const match = rows.find((row: any) =>
      String(row.subject_type) === subject.type && Number(row.subject_id) === subject.id)

    if (!match)
      continue

    const expiresAt = match.expires_at ? Date.parse(String(match.expires_at)) : null

    if (muteApplies({ expiresAt: expiresAt === null || Number.isNaN(expiresAt) ? null : expiresAt }, nowMs))
      return true
  }

  return false
}

/**
 * How long a "mute for a while" lasts.
 *
 * Named durations rather than a free-form number, because the useful ones are
 * few and a date picker for "until I stop being annoyed" is worse than four
 * buttons. `forever` is deliberately last and deliberately explicit.
 */
export const MUTE_DURATIONS = ['1h', '8h', 'tomorrow', 'week', 'forever'] as const

export type MuteDuration = typeof MUTE_DURATIONS[number]

/**
 * When a mute of this duration expires, or null for indefinitely.
 *
 * `tomorrow` and `week` are computed from the recipient's local midnight rather
 * than from now, so "until tomorrow" set at 23:50 does not expire in ten
 * minutes, which is the version of this that people find infuriating.
 */
export function muteExpiry(duration: MuteDuration, timezone: string, nowMs: number): number | null {
  const local = localTimeIn(timezone, nowMs)
  const untilLocalMidnight = (24 * 60 - local.minutes) * 60_000

  switch (duration) {
    case '1h':
      return nowMs + 3_600_000
    case '8h':
      return nowMs + 8 * 3_600_000
    case 'tomorrow':
      return nowMs + untilLocalMidnight
    case 'week':
      return nowMs + untilLocalMidnight + 6 * 24 * 3_600_000
    default:
      return null
  }
}
