/**
 * When a notification is allowed to reach someone, and when it waits.
 *
 * `recipients.ts` decides *who* hears about something. This decides *when*, and
 * it is the half that determines whether people leave the notifications on. A
 * forge does not lose someone by sending the wrong notification; it loses them
 * by sending the right one at eleven at night, twice, until they turn everything
 * off and the reviewer everybody is waiting on becomes unreachable by design.
 *
 * Two ideas, and the difference between them is the whole design:
 *
 *   held      outside someone's hours. Delayed, never dropped: the in-app inbox
 *             gets it immediately, and the push and email leave when the window
 *             opens, rolled into one digest.
 *   muted     this repository or thread, on purpose. The noisy channels are
 *             dropped, and the inbox still records it, marked muted. That is
 *             what makes muting safe enough to use instead of leaving.
 *
 * Pure over plain values. Clocks and timezones are the caller's problem: it
 * passes the recipient's *local* weekday and minute alongside the absolute time,
 * so every rule here can be tested without pretending it is Tuesday in Berlin.
 */

export type Channel = 'in_app' | 'email' | 'push'

export type Decision = 'send' | 'hold' | 'drop'

/**
 * When somebody is reachable, in their own timezone.
 *
 * Weekends are days left out of `days` rather than a flag of their own, because
 * a Sunday-to-Thursday week and a rotating shift are the same shape of problem
 * and a `weekends: false` boolean cannot express either.
 */
export interface Schedule {
  /** Reachable weekdays. 0 is Sunday, 6 is Saturday. */
  days: readonly number[]
  /** Minutes from local midnight. */
  startsAt: number
  /** Minutes from local midnight. A value below `startsAt` wraps past midnight. */
  endsAt: number
}

export interface LocalTime {
  /** Absolute time, for comparing against expiries and for scheduling. */
  epochMs: number
  /** The recipient's local weekday, 0 (Sunday) to 6. */
  weekday: number
  /** Minutes from the recipient's local midnight. */
  minutes: number
}

export interface DeliveryInput {
  channel: Channel
  now: LocalTime
  /** Absent or with no days means unconstrained. */
  schedule?: Schedule | null
  /** The recipient muted this repository, organization, or thread. */
  muted?: boolean
  /** A one-click override, as an absolute time. */
  doNotDisturbUntilMs?: number | null
  /**
   * This event type is on the recipient's break-through list. Empty by default,
   * because a break-through list that fills up is a schedule that does nothing.
   */
  breaksThrough?: boolean
}

export interface DeliveryOutcome {
  decision: Decision
  /** Set when held: when the recipient's window next opens. */
  deliverAtMs?: number
  /** Which rule decided, so the interface can explain it in the same words. */
  because: 'open' | 'muted' | 'quiet-hours' | 'do-not-disturb' | 'breaks-through' | 'inbox'
}

const DAY = 24 * 60

/**
 * Whether a notification goes out now, waits, or is dropped for this channel.
 *
 * The in-app inbox is never held and never dropped. It is the record, and a
 * record with holes in it is what makes people distrust muting and stop using
 * it. Muting and quiet hours only ever silence the channels that interrupt.
 */
export function deliveryDecision(input: DeliveryInput): DeliveryOutcome {
  if (input.channel === 'in_app')
    return { decision: 'send', because: input.muted ? 'muted' : 'inbox' }

  // Muting is a decision about the subject and outranks the clock: there is no
  // hour at which someone wants the repository they muted.
  if (input.muted)
    return { decision: 'drop', because: 'muted' }

  if (input.breaksThrough)
    return { decision: 'send', because: 'breaks-through' }

  const dnd = input.doNotDisturbUntilMs ?? null
  if (dnd !== null && dnd > input.now.epochMs)
    return { decision: 'hold', deliverAtMs: dnd, because: 'do-not-disturb' }

  const schedule = input.schedule
  if (!schedule || schedule.days.length === 0)
    return { decision: 'send', because: 'open' }

  if (isWithinWindow(schedule, input.now.weekday, input.now.minutes))
    return { decision: 'send', because: 'open' }

  return {
    decision: 'hold',
    deliverAtMs: input.now.epochMs + minutesUntilOpen(schedule, input.now) * 60_000,
    because: 'quiet-hours',
  }
}

/**
 * Whether a local weekday and minute fall inside the window.
 *
 * A window whose end is before its start wraps past midnight, and the day it is
 * listed under is the day it *starts*: 22:00 to 06:00 on Monday runs into
 * Tuesday morning. Without that, a night shift has to be entered as two windows
 * and the second one silently covers the wrong days.
 */
export function isWithinWindow(schedule: Schedule, weekday: number, minutes: number): boolean {
  const days = new Set(schedule.days)

  if (schedule.startsAt <= schedule.endsAt)
    return days.has(weekday) && minutes >= schedule.startsAt && minutes < schedule.endsAt

  if (days.has(weekday) && minutes >= schedule.startsAt)
    return true

  return days.has((weekday + 6) % 7) && minutes < schedule.endsAt
}

/**
 * Minutes until the window next opens, from a moment outside it.
 *
 * Walks forward a day at a time rather than solving it in closed form. Eight
 * iterations is nothing, and the closed form has to special-case the wrap, the
 * same-day-but-earlier case, and a schedule with one day in it, each of which is
 * a place to be wrong about someone's evening.
 */
export function minutesUntilOpen(schedule: Schedule, now: { weekday: number, minutes: number }): number {
  const days = new Set(schedule.days)

  for (let ahead = 0; ahead <= 7; ahead += 1) {
    const weekday = (now.weekday + ahead) % 7
    if (!days.has(weekday))
      continue

    const opensAt = ahead * DAY + schedule.startsAt
    const from = now.minutes

    if (opensAt > from)
      return opensAt - from
  }

  // Unreachable for a schedule with any days in it, since a week always comes
  // back around, but a total is better than a crash if one ever is empty.
  return 7 * DAY
}

/**
 * Whether a mute is still in force.
 *
 * A null expiry is indefinite. Every other mute ends by itself, which is the
 * point: "mute until Monday" is a decision somebody can afford to make, and an
 * indefinite mute is one they have to remember to undo.
 */
export function muteApplies(mute: { expiresAt: number | null } | null | undefined, nowMs: number): boolean {
  if (!mute)
    return false

  return mute.expiresAt === null || mute.expiresAt > nowMs
}

/**
 * The sentence settings shows for what would happen right now.
 *
 * Written out rather than assembled from the decision, for the same reason
 * `reasonText` is: this is the text somebody reads before deciding whether their
 * schedule does what they meant.
 */
export function decisionText(outcome: DeliveryOutcome): string {
  switch (outcome.because) {
    case 'muted':
      return outcome.decision === 'send'
        ? 'it would go to your inbox, marked muted'
        : 'it would be dropped, because you muted this'
    case 'quiet-hours':
      return 'it would wait until your next window opens'
    case 'do-not-disturb':
      return 'it would wait until you turn do not disturb off'
    case 'breaks-through':
      return 'it would reach you now, because this event breaks through'
    case 'inbox':
      return 'it would go to your inbox'
    default:
      return 'it would reach you now'
  }
}
