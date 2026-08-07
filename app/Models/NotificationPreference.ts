import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * The framework's channel switch, declared so the corpus knows it exists.
 *
 * This table is created by `@stacksjs/database`'s `notification-tables.ts`, on
 * a guarantee path that runs outside the model corpus, and `@stacksjs/notifications`
 * reads it. Nothing here writes to it today.
 *
 * It is declared anyway, because a table the corpus cannot see is a table
 * `buddy generate:migrations` proposes to *drop* - it compares the models
 * against the schema and an orphan looks like something somebody deleted. The
 * generated `DROP TABLE ... CASCADE` would take a framework table with it, and
 * the fact that the guarantee path would recreate it empty on the next boot is
 * not a defence: it would be recreated without whatever was in it.
 *
 * The shape is the guarantee path's, exactly, down to `enabled` being a boolean
 * and `category` being nullable. This model exists to describe what is there,
 * not to improve it - changing a column here would generate an `ALTER` against
 * a table the framework believes it owns, and then two things would disagree
 * about it on every install.
 *
 * `notification_event_preferences` is the table this product actually uses, and
 * says at length why it is separate: a boolean cannot express `digest`, and
 * `digest` is the option that keeps somebody reachable instead of muted.
 */
export default defineModel({
  name: 'NotificationPreference',
  table: 'notification_preferences',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  attributes: {
    /**
     * `user_id`, as a plain column rather than a `belongsTo`.
     *
     * The guarantee path creates it without a foreign key, and declaring the
     * relation here would generate a constraint the framework does not expect
     * on a table it creates on every boot. The model's job here is to describe,
     * not to correct.
     */
    userId: {
      required: true,
      fillable: true,
      validation: {
        rule: schema.number(),
      },
    },

    channel: {
      required: true,
      fillable: true,
      validation: {
        rule: schema.string().max(50),
      },
    },

    enabled: {
      required: true,
      fillable: true,
      default: true,
      validation: {
        rule: schema.boolean(),
      },
    },

    category: {
      required: false,
      fillable: true,
      validation: {
        rule: schema.string().max(255),
      },
    },
  },
} as const)
