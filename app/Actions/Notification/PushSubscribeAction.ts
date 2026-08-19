import { Action } from '@stacksjs/actions'
import { currentUser } from '../Identity/lookup'
import { vapidKeys } from './vapid'
import { dbTimestamp } from '../Support/sql'

/**
 * Register, refresh, or drop this browser's push subscription.
 *
 * One endpoint with the operation in the body, because all three turn on the
 * same question - is this endpoint already ours - and splitting them is how
 * that check ends up written three times and forgotten once.
 *
 * **Upserted on the endpoint, not created.** A browser re-subscribes on its own
 * schedule: after a service worker update, after a permission re-grant, after
 * the push service rotates the endpoint. Inserting each time would leave one
 * person with nine rows and ring them nine times, and every one of those rows
 * would be live.
 *
 * The endpoint is unique across the table rather than per user, deliberately.
 * It names one browser, and if it somehow moved between accounts the old owner
 * must stop receiving - a duplicate scoped per user would keep ringing them.
 */
export default new Action({
  name: 'PushSubscribe',
  description: 'Register or remove this browser for push notifications',
  method: 'POST',

  async handle(request: RequestInstance) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const endpoint = String(request.get('endpoint') ?? '').trim()

    if (!endpoint || !/^https:\/\//.test(endpoint))
      return response.json({ error: 'A push endpoint is an https URL' }, 422)

    if (String(request.get('operation') ?? '') === 'delete') {
      // Scoped to this user. Without that, anybody who learns an endpoint could
      // unsubscribe somebody else's browser - which is not a disclosure, but is
      // a way to silence a reviewer.
      await db
        .deleteFrom('push_subscriptions')
        .where('user_id', '=', user.id)
        .where('endpoint', '=', endpoint)
        .execute()

      return response.json({ subscribed: false })
    }

    const p256dh = String(request.get('p256dh') ?? '').trim()
    const auth = String(request.get('auth') ?? '').trim()

    // Both, or neither is any use. A row with one key is one that can never
    // accept an encrypted payload, and an encrypted payload is the only kind
    // the protocol has - so it would sit there failing forever.
    if (!p256dh || !auth)
      return response.json({ error: 'A subscription needs both keys' }, 422)

    // `last_seen_at` is one of the four columns this schema declares as a
    // date rather than as an ISO string, so it needs the literal both engines
    // take - see `dbTimestamp`.
    const now = dbTimestamp()
    const userAgent = String(request.header?.('user-agent') ?? '').slice(0, 500)

    const existing = await db
      .selectFrom('push_subscriptions')
      .select(['id'])
      .where('endpoint', '=', endpoint)
      .executeTakeFirst()

    if (existing) {
      await db
        .updateTable('push_subscriptions')
        .set({ user_id: user.id, public_key: p256dh, auth_secret: auth, user_agent: userAgent, last_seen_at: now })
        .where('id', '=', Number(existing.id))
        .execute()
    }
    else {
      await db.insertInto('push_subscriptions').values({
        user_id: user.id,
        endpoint,
        // The wire names map to the column names here, which is the one place
        // the Push API vocabulary belongs.
        public_key: p256dh,
        auth_secret: auth,
        user_agent: userAgent,
        last_seen_at: now,
      }).execute()
    }

    // The public key travels back so the page can confirm the browser
    // subscribed against the key this instance actually holds. A mismatch is
    // otherwise invisible until the first notification silently fails.
    return response.json({ subscribed: true, publicKey: vapidKeys()?.publicKey ?? null })
  },
})
