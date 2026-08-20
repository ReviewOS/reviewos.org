import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { currentUser } from '../Identity/lookup'
import { formatDays, localTimeIn, parseDays } from './clock'
import { decisionText, deliveryDecision } from './delivery'

/**
 * Set when somebody is reachable.
 *
 * The response says, in words, what would happen to a review request right now.
 * A week grid that does not tell you what it means is how people end up with a
 * schedule that silences the thing they were waiting for, discover it a week
 * later, and turn the whole feature off.
 */
export default new Action({
  name: 'UpdateNotificationSchedule',
  description: 'Set the hours and days notifications may interrupt you',
  method: 'PUT',

  // Declared so the document can publish them: every key is one the handler
  // reads. **Enforced, not descriptive**: the framework checks these before the
  // handler runs and answers 422 itself, so a named type here is a promise that
  // the endpoint refuses every other spelling of the value. A field the handler
  // coerces takes `coerced` from `app/Actions/inputs.ts` instead.
  validations: {
    breaks_through: { rule: schema.string() },
    days: { rule: schema.number() },
    do_not_disturb_until: { rule: schema.string() },
    ends_at: { rule: schema.string() },
    starts_at: { rule: schema.string() },
    timezone: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const existing = await db
      .selectFrom('notification_schedules')
      .select(['id', 'days', 'starts_at', 'ends_at', 'timezone', 'breaks_through', 'do_not_disturb_until'])
      .where('user_id', '=', user.id)
      .executeTakeFirst()

    const days = request.get('days') === undefined
      ? String(existing?.days ?? '1,2,3,4,5')
      : formatDays(parseDays(String(request.get('days'))))

    const startsAt = minute(request.get('starts_at'), Number(existing?.starts_at ?? 540))
    const endsAt = minute(request.get('ends_at'), Number(existing?.ends_at ?? 1080))

    if (startsAt === null || endsAt === null)
      return response.json({ error: 'A time is a minute from midnight, 0 to 1439' }, 422)

    // Equal start and end would be a window of zero length that reads as "all
    // day" to whoever set it. Refusing is kinder than silencing them.
    if (startsAt === endsAt)
      return response.json({ error: 'A window needs a start and an end that differ' }, 422)

    const timezone = String(request.get('timezone') ?? existing?.timezone ?? 'UTC')
    if (!isKnownTimezone(timezone))
      return response.json({ error: 'That is not a timezone name' }, 422)

    const breaksThrough = request.get('breaks_through') === undefined
      ? String(existing?.breaks_through ?? '')
      : String(request.get('breaks_through'))

    const doNotDisturbUntil = request.get('do_not_disturb_until') === undefined
      ? (existing?.do_not_disturb_until ?? null)
      : normalizeTime(request.get('do_not_disturb_until'))

    const values = {
      days,
      starts_at: startsAt,
      ends_at: endsAt,
      timezone,
      breaks_through: breaksThrough,
      do_not_disturb_until: doNotDisturbUntil,
    }

    if (existing) {
      await db
        .updateTable('notification_schedules')
        .set(values)
        .where('id', '=', Number(existing.id))
        .execute()
    }
    else {
      await db
        .insertInto('notification_schedules')
        .values({ user_id: user.id, ...values })
        .execute()
    }

    // What this schedule would do to an ordinary review request, right now.
    const nowMs = Date.now()
    const outcome = deliveryDecision({
      channel: 'push',
      now: localTimeIn(timezone, nowMs),
      schedule: { days: parseDays(days), startsAt, endsAt },
      doNotDisturbUntilMs: doNotDisturbUntil ? Date.parse(String(doNotDisturbUntil)) : null,
    })

    return response.json({
      ...values,
      right_now: {
        decision: outcome.decision,
        deliver_at: outcome.deliverAtMs ? new Date(outcome.deliverAtMs).toISOString() : null,
        explanation: `If your review were requested now, ${decisionText(outcome)}.`,
      },
    })
  },
})

/** A minute from midnight, or null when the value is present but not one. */
function minute(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null || value === '')
    return fallback

  const parsed = Number(value)

  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 1439 ? parsed : null
}

/** An ISO timestamp, or null when the caller is clearing the value. */
function normalizeTime(value: unknown): string | null {
  if (value === null || value === '' || value === undefined)
    return null

  const parsed = Date.parse(String(value))

  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

/**
 * Whether a timezone name is one the runtime knows.
 *
 * Asked here rather than at delivery: `localTimeIn` falls back to UTC so a bad
 * value never loses a notification, but silently storing one would leave
 * somebody with a schedule that is hours out and no way to tell why.
 */
function isKnownTimezone(timezone: string): boolean {
  try {
    // Throws a RangeError on an unknown zone, which is the check.
    void new Intl.DateTimeFormat('en-US', { timeZone: timezone })

    return true
  }
  catch {
    return false
  }
}
