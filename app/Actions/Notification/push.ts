import { vapidKeys } from './vapid'

/**
 * Ringing somebody's browsers, and forgetting the ones that are gone.
 *
 * Shared by `SendNotificationJob` and the test button in settings, so the thing
 * being tested is the thing that runs. A test path that built its own payload
 * would prove the test path works, which is the one guarantee nobody needs.
 *
 * **Pruning is not an optimisation.** A push service answers `404` or `410`
 * when a subscription is permanently gone - the browser was uninstalled,
 * permission was revoked, the profile was wiped - and it will never accept
 * again. Keeping the row means every future notification spends a request on it
 * forever, and the delivery log fills with failures nobody can act on. Every
 * other failure is transient and the row stays: deleting on a 429 or a 500
 * would sign somebody out of push because a push service had a bad afternoon.
 */

export interface PushOutcome {
  /** Browsers that rang. */
  sent: number
  /** Rows deleted because the endpoint is gone for good. */
  pruned: number
  /** Failures worth retrying: the endpoint is fine, something else was not. */
  failed: number
  /** Set when this instance has no VAPID keys, so callers can say why. */
  unconfigured?: boolean
}

export interface PushMessage {
  title: string
  /** A path on this host. The service worker makes it absolute. */
  url: string
  /** The line under the headline. */
  body?: string
  /**
   * The collapse key.
   *
   * Three notifications about one pull request should replace each other rather
   * than stack: a device that was asleep wakes to one current notification
   * instead of three stale ones, and the reader taps once. Sent as the push
   * service's `Topic` header *and* as the browser's notification tag, because
   * the two collapse at different points - the service collapses while the
   * browser is offline, the tag collapses once it is awake - and using only one
   * leaves the other case stacking.
   */
  tag?: string
  /** `high` for anything somebody is blocked on. */
  urgency?: 'very-low' | 'low' | 'normal' | 'high'
}

/**
 * Send to every browser this person registered.
 *
 * Never throws. Push is one channel of three, and a browser that will not
 * accept must not cost somebody the inbox row or the email.
 */
export async function pushToUser(userId: number, message: PushMessage): Promise<PushOutcome> {
  const vapid = vapidKeys()

  // No keys is not a failure. An instance that never configured push should
  // send email and fill the inbox exactly as before, and say so rather than
  // reporting a delivery that was never attempted.
  if (!vapid)
    return { sent: 0, pruned: 0, failed: 0, unconfigured: true }

  const rows: any[] = await db
    .selectFrom('push_subscriptions')
    .select(['id', 'endpoint', 'public_key', 'auth_secret'])
    .where('user_id', '=', userId)
    .execute()

  if (rows.length === 0)
    return { sent: 0, pruned: 0, failed: 0 }

  const { sendWebPush } = await import('@stacksjs/push')

  /*
   * What the service worker receives.
   *
   * **A title, a URL, and nothing else.** The payload is encrypted end to end,
   * so a push service cannot read it - but it lands on a device that may be
   * shared, unlocked on a desk, or mirrored to a watch, and a notification
   * preview is shown before anybody authenticates. So it carries no diff, no
   * comment body, and no private file name: only what the recipient could
   * already read, phrased the way the inbox phrases it.
   */
  const payload = JSON.stringify({
    title: message.title,
    body: message.body ?? '',
    url: message.url,
    tag: message.tag ?? '',
  })

  const outcome: PushOutcome = { sent: 0, pruned: 0, failed: 0 }
  const dead: number[] = []

  for (const row of rows) {
    try {
      const result = await sendWebPush({
        subscription: {
          endpoint: String(row.endpoint),
          // Back to the wire names, which is what the driver and the browser
          // both speak.
          keys: { p256dh: String(row.public_key), auth: String(row.auth_secret) },
        },
        payload,
        vapid,
        subject: vapid.subject,
        urgency: message.urgency ?? 'normal',
        // Base64url and at most 32 characters, which every push service
        // enforces by rejecting the request rather than by ignoring the header.
        topic: message.tag ? topicOf(message.tag) : undefined,
      })

      if (result.success)
        outcome.sent += 1
      else if (result.expired)
        dead.push(Number(row.id))
      else
        outcome.failed += 1
    }
    catch (error) {
      // A throw here is not evidence the subscription is dead, so the row
      // stays. Reported, because a push channel that silently stopped is the
      // failure this codebase has already been bitten by twice.
      console.error('[push] could not send:', error)
      outcome.failed += 1
    }
  }

  if (dead.length > 0) {
    await db.deleteFrom('push_subscriptions').where('id', 'in', dead).execute()
    outcome.pruned = dead.length
  }

  return outcome
}

/**
 * A tag the push service will accept as a `Topic`.
 *
 * Base64url, 32 characters at most. A tag like `pull_request:4821` is neither,
 * and a push service answers the whole request with a 400 rather than dropping
 * the header - so an unencoded tag does not degrade to "no collapsing", it
 * stops the notification entirely.
 */
export function topicOf(tag: string): string {
  return Buffer.from(tag).toString('base64url').slice(0, 32)
}
