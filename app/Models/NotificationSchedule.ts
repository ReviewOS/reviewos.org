import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * When somebody is reachable.
 *
 * Weekends are days left out of `days` rather than a flag of their own. A
 * `weekends: false` boolean cannot express a Sunday-to-Thursday week or a
 * rotating shift, and both of those are ordinary rather than exotic.
 *
 * The timezone is stored on the row rather than read from the user at delivery
 * time, so a schedule that was set as "18:00 my time" keeps meaning that after
 * a move, and so a held notification can be scheduled without loading the user.
 *
 * The rules that read this are in `app/Actions/Notification/delivery.ts`, and
 * they are pure: this model holds the values, nothing else.
 */
export default defineModel({
  name: 'NotificationSchedule',
  table: 'notification_schedules',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'notification_schedules_user_index', columns: ['user_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 10 },
  },

  belongsTo: ['User'],

  attributes: {
    user_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /**
     * Reachable weekdays as a sorted list of digits, 0 (Sunday) to 6.
     *
     * An empty list means the schedule constrains nothing. Holding every
     * notification forever is the worst failure this feature can have, and an
     * empty list is never what somebody meant by it.
     */
    days: {
      order: 2,
      fillable: true,
      default: '1,2,3,4,5',
      validation: { rule: schema.string().max(20) },
      factory: () => '1,2,3,4,5',
    },

    /** Minutes from local midnight. */
    starts_at: {
      order: 3,
      fillable: true,
      default: 540,
      validation: { rule: schema.number().min(0).max(1439) },
      factory: () => 540,
    },

    /**
     * Minutes from local midnight. A value below `starts_at` wraps past
     * midnight, and the window belongs to the day it starts on, so a night
     * shift is one row rather than two.
     */
    ends_at: {
      order: 4,
      fillable: true,
      default: 1080,
      validation: { rule: schema.number().min(0).max(1439) },
      factory: () => 1080,
    },

    timezone: {
      order: 5,
      fillable: true,
      default: 'UTC',
      validation: { rule: schema.string().max(64) },
      factory: () => 'UTC',
    },

    /**
     * Event types that reach the recipient whatever the hour, comma separated.
     *
     * Empty by default. A break-through list that fills up is a schedule that
     * does nothing, so the interface says plainly what it is letting past.
     */
    breaks_through: {
      order: 6,
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(500) },
      factory: () => '',
    },

    /**
     * A one-click override that ends by itself: an hour, until tomorrow, until
     * Monday. Independent of the window above.
     */
    do_not_disturb_until: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },
  },
} as const)
