import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One person's answer to "how do you want to hear about this kind of thing".
 *
 * **Not `notification_preferences`.** The framework guarantees a table of that
 * name from `@stacksjs/database`'s `notification-tables.ts`, outside the model
 * corpus, shaped `(user_id, channel, category, enabled)` - a boolean per
 * channel per category, which `@stacksjs/notifications` reads. It cannot
 * express the thing this phase is actually about: `digest` is a third answer,
 * not a shade of on, and collapsing it to a checkbox is how people who wanted
 * less mail end up turning the channel off entirely and becoming unreachable
 * for the review everybody is waiting on.
 *
 * So this is a different table answering a different question, rather than the
 * framework's bent into a shape it does not fit. The collision is worth knowing
 * about: a generated `CREATE TABLE IF NOT EXISTS` against a name the guarantee
 * path already claimed does nothing at all, silently, and the first sign is a
 * query for a column that is not there.
 *
 * A row per user, per event type, per channel, and no rows for most people:
 * absence means the default for that event, which is what makes this table
 * small and what makes changing a default actually change anything. A table
 * pre-filled with every combination at install would freeze today's defaults
 * into every account ever created.
 *
 * **The delivery value is three-state, not a boolean.** `off`, `immediate`, and
 * `digest` are genuinely different answers, and collapsing them to a checkbox is
 * how forges end up with people who wanted less mail turning off the channel
 * entirely - and then being unreachable for the review everybody is waiting on.
 * Digest is the option that keeps somebody reachable while giving them what they
 * actually asked for, so it has to exist before the switch is offered.
 *
 * Scoped per event *and* per channel because the two are independent in a way
 * one axis cannot express. "Email me about review requests, never about
 * releases; push everything" is an ordinary preference and needs both.
 *
 * `useSeeder` is off. Seeded preferences would be somebody's opinion attached to
 * a factory account, and every query here means something about a real person.
 */
export default defineModel({
  name: 'NotificationEventPreference',
  table: 'notification_event_preferences',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  belongsTo: [{ model: 'User', onDelete: 'cascade' }],

  attributes: {
    /**
     * The event type, as `app/Notifications/definitions.ts` spells it.
     *
     * Stored as a string rather than an enum column so adding an event is a
     * code change rather than a migration. The interface only ever offers the
     * nine that exist, and a row naming an event nobody emits is inert.
     */
    event: {
      required: true,
      fillable: true,
      validation: {
        rule: schema.string().max(64),
      },
    },

    channel: {
      required: true,
      fillable: true,
      validation: {
        rule: schema.enum(['in_app', 'email', 'push']),
      },
    },

    /**
     * `off`, `immediate`, or `digest`.
     *
     * `in_app` only meaningfully takes `immediate`: the inbox is the channel
     * that has to work when the others do not, and a digest of it would be a
     * page somebody has to wait for. The value is still stored per channel so
     * one shape serves all three, and the rules module is what refuses the
     * combination rather than the column.
     */
    delivery: {
      required: true,
      fillable: true,
      default: 'immediate',
      validation: {
        rule: schema.enum(['off', 'immediate', 'digest']),
      },
    },
  },
} as const)
