import type { Channel } from './delivery'

/**
 * What each channel does with each kind of event, by default and by choice.
 *
 * The defaults matter more than the switches. Most people never open a settings
 * page, so what ships is what almost everybody gets, and a forge that emails
 * every watcher about every comment is one people mute in week two - after
 * which they are unreachable for the review everybody is waiting on, which is
 * the failure this whole phase exists to avoid.
 *
 * So the defaults are asymmetric on purpose. **Email is for things addressed to
 * you**: a review request, a mention, a verdict on your own pull request. It is
 * not for things you merely watch, because watching a busy repository would
 * otherwise be indistinguishable from subscribing to a mailing list. The inbox
 * gets everything, always, because it is the channel somebody chose to open.
 *
 * Pure over plain values, like `delivery.ts` next door. `settings.ts` is the
 * half that reads the database.
 */

export type Delivery = 'off' | 'immediate' | 'digest'

/** Everything the nine events are, as `app/Notifications/definitions.ts` spells them. */
export const PREFERENCE_EVENTS = [
  'review:requested',
  'review:submitted',
  'pr:opened',
  'pr:merged',
  'pr:closed',
  'issue:opened',
  'issue:closed',
  'comment:created',
  'release:published',
] as const

export const PREFERENCE_CHANNELS: readonly Channel[] = ['in_app', 'email', 'push']

/**
 * Events that reach a specific person rather than an audience.
 *
 * These are the ones somebody is *blocked on*, so email defaults to immediate
 * for them and to digest for everything else. A review request that waits four
 * hours in a digest is four hours of somebody else's day.
 */
const ADDRESSED_EVENTS = new Set<string>([
  'review:requested',
  'review:submitted',
])

/**
 * What happens to this event on this channel when nobody has said otherwise.
 *
 * `in_app` is always immediate. The inbox is the channel that has to work when
 * the others do not, and a digest of it would be a page somebody has to wait
 * for - the whole point is that it is already there when they look.
 *
 * `push` is off by default rather than digest. A push nobody asked for is an
 * interruption, and a digest push is an interruption about a list; the channel
 * is worth having precisely because it is opt-in and therefore trusted.
 */
export function defaultDelivery(event: string, channel: Channel): Delivery {
  if (channel === 'in_app')
    return 'immediate'

  if (channel === 'push')
    return 'off'

  return ADDRESSED_EVENTS.has(event) ? 'immediate' : 'digest'
}

/** A stored preference row, reduced to what the rule needs. */
export interface StoredPreference {
  event: string
  channel: string
  delivery: string
}

/**
 * The chosen delivery, or the default when nobody chose.
 *
 * An unrecognised stored value falls back to the default rather than being
 * treated as `off`. A preference table that has drifted - a value renamed, a
 * row written by an older version - should degrade to the shipped behaviour,
 * not to silence: the failure mode of "wrong but talking" is a notification
 * somebody did not want, and of "wrong and silent" is a review nobody knew
 * about.
 *
 * `in_app` is forced to immediate whatever is stored, for the reason in
 * `defaultDelivery`. The column allows the other values so one shape serves all
 * three channels; this is where the combination is refused.
 */
export function deliveryPreference(
  event: string,
  channel: Channel,
  stored: readonly StoredPreference[],
): Delivery {
  if (channel === 'in_app')
    return 'immediate'

  const row = stored.find(entry => entry.event === event && entry.channel === channel)

  if (!row)
    return defaultDelivery(event, channel)

  return isDelivery(row.delivery) ? row.delivery : defaultDelivery(event, channel)
}

export function isDelivery(value: unknown): value is Delivery {
  return value === 'off' || value === 'immediate' || value === 'digest'
}

/**
 * The whole grid, for the settings page.
 *
 * Every cell is answered, including the ones nobody has a row for, so the page
 * shows what would actually happen rather than a blank where a default lives.
 * A settings screen that renders unset as "off" is how somebody turns something
 * on that was already on and concludes the switches do nothing.
 */
export interface GridCell {
  event: string
  channel: Channel
  delivery: Delivery
  /** Whether this is the shipped default rather than something they chose. */
  isDefault: boolean
  /** Whether the reader can change it. `in_app` is fixed. */
  editable: boolean
}

export function preferenceGrid(stored: readonly StoredPreference[]): GridCell[] {
  const cells: GridCell[] = []

  for (const event of PREFERENCE_EVENTS) {
    for (const channel of PREFERENCE_CHANNELS) {
      const row = stored.find(entry => entry.event === event && entry.channel === channel)
      const chosen = row && isDelivery(row.delivery) && channel !== 'in_app'

      cells.push({
        event,
        channel,
        delivery: deliveryPreference(event, channel, stored),
        isDefault: !chosen,
        editable: channel !== 'in_app',
      })
    }
  }

  return cells
}
