import type { Channel } from '../Actions/Notification/delivery'
import { Job } from '@stacksjs/queue'
import { deliveryFor } from '../Actions/Notification/settings'
import { deliveryPreference } from '../Actions/Notification/preferences'

/**
 * Send one notification on one interrupting channel.
 *
 * The inbox is not here. `app/Listeners/Notify.ts` writes it inline, because it
 * is one insert per recipient and it is the channel that has to work when
 * nothing else does - a reader who opens the product should see what happened
 * whether or not mail is configured, a worker is running, or the network is up.
 * Email and push are the channels that *should* be deferred: they are slow, they
 * fail in ways worth retrying, and nobody is watching a page while they go out.
 *
 * **The decision is made here, not by the caller.** Preferences, quiet hours,
 * mutes and do-not-disturb all move between the moment something happens and
 * the moment a worker picks the job up, and the answer that matters is the one
 * true when the message would actually arrive. A caller that decided in advance
 * would send mail at 03:00 that was correct at 22:00.
 *
 * Every outcome is written to `notification_deliveries`, including the ones that
 * did not send. "Held until 09:00" and "the recipient turned email off" are
 * answers somebody will need when they ask why they did not hear about
 * something, and a log that only records successes cannot give either.
 *
 * `tries: 3` with a growing backoff. A mail server that refuses once usually
 * accepts a minute later, and one that refuses three times is not going to
 * accept the fourth - at which point the row says so and stops.
 */
export default new Job({
  name: 'SendNotification',
  description: 'Deliver one notification on one channel',
  queue: 'notifications',
  tries: 3,
  backoff: 60,

  async handle(payload: {
    userId: number
    event: string
    channel: Channel
    title: string
    url: string
    /** The subject and everything it sits inside, so the widest mute wins. */
    subjects?: Array<{ type: 'repository' | 'organization' | 'issue' | 'pull_request', id: number }>
  }) {
    const userId = Number(payload?.userId)
    const channel = payload?.channel

    if (!Number.isFinite(userId) || (channel !== 'email' && channel !== 'push'))
      return { ok: false, reason: 'not a deferrable channel' }

    const user: any = await db
      .selectFrom('users')
      .select(['id', 'email', 'handle'])
      .where('id', '=', userId)
      .executeTakeFirst()

    // A deleted account is not a failure worth retrying. Returning rather than
    // throwing is the difference between one quiet no-op and three.
    if (!user)
      return { ok: false, reason: 'recipient no longer exists' }

    const stored: any[] = await db
      .selectFrom('notification_event_preferences')
      .select(['event', 'channel', 'delivery'])
      .where('user_id', '=', userId)
      .execute()

    const preference = deliveryPreference(String(payload.event), channel, stored.map(row => ({
      event: String(row.event),
      channel: String(row.channel),
      delivery: String(row.delivery),
    })))

    if (preference === 'off') {
      await record(userId, channel, user.email, payload, 'skipped', 'the recipient turned this channel off')
      return { ok: true, sent: false, reason: 'off' }
    }

    // A digest is not this job. It is recorded as pending and the digest sweep
    // is what rolls it up - sending it now would make "digest" mean "immediate
    // with extra steps", which is exactly the setting people stop trusting.
    if (preference === 'digest') {
      await record(userId, channel, user.email, payload, 'pending', 'held for the digest')
      return { ok: true, sent: false, reason: 'digest' }
    }

    const outcome = await deliveryFor({
      userId,
      channel,
      event: String(payload.event),
      subjects: payload.subjects ?? [],
      nowMs: Date.now(),
    })

    if (outcome.decision === 'drop') {
      await record(userId, channel, user.email, payload, 'skipped', outcome.because)
      return { ok: true, sent: false, reason: outcome.because }
    }

    if (outcome.decision === 'hold') {
      // Held, never dropped. The row carries when the window opens so the
      // digest sweep can find it and so somebody asking "why did I not hear
      // about this" gets a time rather than a shrug.
      await record(userId, channel, user.email, payload, 'pending', outcome.because)
      return { ok: true, sent: false, reason: outcome.because, deliverAtMs: outcome.deliverAtMs }
    }

    const sent = await send(channel, user, payload)

    await record(userId, channel, sent.recipient, payload, sent.ok ? 'sent' : 'failed', sent.error)

    // Thrown rather than returned, so the queue retries. A refused connection
    // is the case `tries` exists for; a preference is not.
    if (!sent.ok)
      throw new Error(`[notification] ${channel} to ${user.handle} failed: ${sent.error}`)

    return { ok: true, sent: true }
  },
})

/**
 * Put it on the wire.
 *
 * Push is not implemented and says so rather than pretending. A channel that
 * silently succeeds is worse than one that visibly does not exist: the delivery
 * log would fill with rows claiming somebody was reached.
 */
async function send(
  channel: Channel,
  user: { email?: string, handle?: string },
  payload: { title: string, url: string },
): Promise<{ ok: boolean, recipient: string, error?: string }> {
  if (channel === 'push')
    return { ok: false, recipient: String(user.handle ?? ''), error: 'push is not wired up yet' }

  const address = String(user.email ?? '')

  if (!address)
    return { ok: false, recipient: '', error: 'no address on file' }

  try {
    const { mail } = await import('@stacksjs/email')

    const result: any = await mail.send({
      to: address,
      subject: payload.title,
      // Plain text, deliberately, until `resources/emails/*.stx` exists. A
      // notification is one sentence and a link, and an HTML template that
      // renders as a wall of table markup in a text client is a worse version
      // of this.
      text: `${payload.title}\n\n${absolute(payload.url)}\n`,
    })

    // It *resolves* with `{ success: false }` on a refused connection rather
    // than throwing. Awaiting it and assuming success is how a delivery log
    // fills with rows claiming somebody was reached when the mail server was
    // down the whole time, and it is the one thing that log exists to be
    // trusted about.
    if (result?.success === false)
      return { ok: false, recipient: address, error: String(result?.message ?? 'the mail driver refused it') }

    return { ok: true, recipient: address }
  }
  catch (error) {
    return { ok: false, recipient: address, error: error instanceof Error ? error.message : String(error) }
  }
}

/** A link that works from outside the product. */
function absolute(url: string): string {
  const base = String(Bun.env.APP_URL ?? '').replace(/\/+$/, '')

  return url.startsWith('http') ? url : `${base}${url}`
}

/**
 * Write what happened, whatever happened.
 *
 * Never throws. A delivery log that can fail the delivery it is logging is a
 * log that makes the product less reliable than not having one.
 */
async function record(
  userId: number,
  channel: Channel,
  recipient: string,
  payload: { title: string, url: string },
  status: 'sent' | 'failed' | 'skipped' | 'pending',
  detail?: string,
): Promise<void> {
  try {
    await db.insertInto('notification_deliveries').values({
      user_id: userId,
      channel,
      recipient: recipient || '',
      subject: payload.title,
      body: absolute(payload.url),
      status,
      sent_at: status === 'sent' ? new Date().toISOString() : null,
      error: detail ?? null,
    }).execute()
  }
  catch (error) {
    console.error('[notification] could not record the delivery:', error)
  }
}
