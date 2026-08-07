import type { Channel } from './delivery'
import { Action } from '@stacksjs/actions'
import { currentUser } from '../Identity/lookup'
import { defaultDelivery, isDelivery, PREFERENCE_CHANNELS, PREFERENCE_EVENTS } from './preferences'

/**
 * Set how one kind of event reaches somebody on one channel.
 *
 * One cell at a time, because that is what the settings page offers and because
 * a whole-grid submit means a stale page can overwrite a change made in another
 * tab with values it read five minutes ago.
 *
 * **Choosing the default deletes the row rather than storing it.** A stored
 * "digest" that happens to equal today's default is indistinguishable from a
 * deliberate choice, and it freezes that default forever: change what ships and
 * everybody who ever clicked the button keeps the old behaviour. Absence means
 * "whatever the product thinks is right", which is what somebody who never
 * touched the setting is getting, and it should stay the same answer.
 *
 * `in_app` is refused rather than silently ignored. The inbox is the record and
 * cannot be turned off; a switch that accepts a value and does nothing with it
 * is worse than one that is not there.
 */
export default new Action({
  name: 'UpdateNotificationPreference',
  description: 'Set the delivery for one event on one channel',
  method: 'POST',

  async handle(request: any) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const event = String(request.get('event') ?? '')
    if (!(PREFERENCE_EVENTS as readonly string[]).includes(event))
      return response.json({ error: 'That is not an event this product sends' }, 422)

    const channel = String(request.get('channel') ?? '') as Channel
    if (!PREFERENCE_CHANNELS.includes(channel))
      return response.json({ error: 'A channel is email or push' }, 422)

    if (channel === 'in_app')
      return response.json({ error: 'The inbox is the record and cannot be turned off' }, 422)

    const delivery = String(request.get('delivery') ?? '')
    if (!isDelivery(delivery))
      return response.json({ error: 'A delivery is off, immediate, or digest' }, 422)

    const existing: any = await db
      .selectFrom('notification_event_preferences')
      .select(['id'])
      .where('user_id', '=', user.id)
      .where('event', '=', event)
      .where('channel', '=', channel)
      .executeTakeFirst()

    if (delivery === defaultDelivery(event, channel)) {
      if (existing) {
        await db
          .deleteFrom('notification_event_preferences')
          .where('id', '=', Number(existing.id))
          .execute()
      }
    }
    else if (existing) {
      await db
        .updateTable('notification_event_preferences')
        .set({ delivery })
        .where('id', '=', Number(existing.id))
        .execute()
    }
    else {
      await db.insertInto('notification_event_preferences').values({
        user_id: user.id,
        event,
        channel,
        delivery,
      }).execute()
    }

    // A form post has nowhere to go afterwards. The page reads the grid on
    // every load, so what it shows next is the state that was just written
    // rather than what this response claims.
    if (wantsHtml(request))
      return response.redirect('/settings/notifications')

    return response.json({ event, channel, delivery })
  },
})

/** Whether this arrived from a form rather than from fetch. */
function wantsHtml(request: any): boolean {
  const accept = String(request.header?.('accept') ?? request.headers?.get?.('accept') ?? '')

  return accept.includes('text/html')
}
