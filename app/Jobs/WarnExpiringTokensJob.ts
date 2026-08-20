import { Job } from '@stacksjs/queue'
import { tokenState } from '../TokenScopes'
import { describeDeadline, warningFor, widestWindowMs } from '../Actions/Tokens/expiry'

/**
 * Tell people their tokens are about to stop working.
 *
 * The instance refuses to issue a token that never expires, and that refusal is
 * right. On its own, though, it teaches the opposite of what it intends: a
 * build that fails at 02:00 because a token lapsed with no warning is an
 * argument for always picking the longest expiry available and never thinking
 * about it again. This is what makes an expiry a deadline instead of an ambush.
 *
 * A sweep rather than a timer armed when each token is issued. A timer has to
 * survive ninety days and a restart; a sweep reads what is actually close and
 * cannot lose one. Daily is the right cadence because the thresholds are in
 * days - running hourly would find the same tokens twenty-four times and send
 * nothing extra, because `expiry_warned_days` records what has gone.
 *
 * The decision is `warningFor`, which is pure and tested on its boundaries. All
 * this does is find the candidates, ask, and record the answer.
 */
export default new Job({
  name: 'WarnExpiringTokensJob',
  description: 'Warn owners of tokens that are about to expire',
  queue: 'notifications',
  tries: 2,
  backoff: 120,

  async handle(payload: { nowMs?: number } = {}): Promise<{ examined: number, warned: number }> {
    const nowMs = Number(payload?.nowMs ?? Date.now())

    // Bounded in SQL rather than by reading every token and filtering in
    // memory: on an instance with real usage most tokens are months from
    // expiring and there is no reason to load them.
    const horizon = new Date(nowMs + widestWindowMs()).toISOString()

    const rows = await db
      .selectFrom('access_tokens')
      .select(['id', 'user_id', 'name', 'expires_at', 'revoked_at', 'expiry_warned_days'])
      .whereNull('revoked_at')
      .where('expires_at', '<=', horizon)
      .execute()

    let warned = 0

    for (const row of rows as any[]) {
      const expiresAtMs = parseTime(row.expires_at)

      const decision = warningFor({
        state: tokenState({ expiresAtMs, revokedAtMs: parseTime(row.revoked_at) }, nowMs),
        expiresAtMs,
        warnedDays: row.expiry_warned_days === null || row.expiry_warned_days === undefined
          ? null
          : Number(row.expiry_warned_days),
      }, nowMs)

      if (!decision.warn)
        continue

      const userId = Number(row.user_id)
      const name = String(row.name)
      const when = describeDeadline(decision.daysLeft)
      const title = `Your access token "${name}" expires ${when}`

      // Recorded before the message goes out, not after. A send that throws
      // half way would otherwise be retried by the queue and warn again on the
      // next sweep, and a warning that arrives twice is the one people build a
      // filter for - which then hides the one-day warning too.
      await db
        .updateTable('access_tokens')
        .set({ expiry_warned_days: decision.thresholdDays })
        .where('id', '=', Number(row.id))
        .execute()

      await db.insertInto('notifications').values({
        user_id: userId,
        type: 'token:expiring',
        data: JSON.stringify({
          title,
          // Straight to the page that can do something about it. Rotation is
          // the action this message is asking for, and it lives here.
          url: '/settings/tokens',
          reason: 'token_expiring',
          repository: null,
          number: null,
        }),
      }).execute()

      await queueEmail({
        userId,
        event: 'token:expiring',
        channel: 'email',
        title,
        url: '/settings/tokens',
        repository: null,
        // Said plainly, because the useful reply to this mail is an action and
        // the reader needs to know which one. Rotating keeps the old token
        // alive for a day, which is the part that makes acting on this cheap.
        reason: 'a token on your account is about to expire. Rotating it issues a replacement and leaves this one working for 24 hours',
        subjects: [],
      })

      warned++
    }

    return { examined: rows.length, warned }
  },
})

/**
 * Hand the email to the notification job.
 *
 * Never allowed to fail the sweep. A mail server that is down should not mean
 * the remaining tokens go unwarned, and the row is already marked - the next
 * threshold still has its own warning to send.
 */
async function queueEmail(payload: Record<string, unknown>): Promise<void> {
  try {
    const SendNotificationJob = (await import('./SendNotificationJob')).default

    await SendNotificationJob.dispatch(payload as any)
  }
  catch (error) {
    console.error('[tokens] could not queue an expiry warning:', error)
  }
}

function parseTime(value: unknown): number | null {
  if (value === null || value === undefined || value === '')
    return null

  const parsed = Date.parse(String(value))

  return Number.isNaN(parsed) ? null : parsed
}
