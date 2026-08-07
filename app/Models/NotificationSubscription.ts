import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Why somebody hears about a thread.
 *
 * Subscription is implicit: opening, commenting on, or being assigned to
 * something subscribes you, and the reason is recorded so the notification can
 * say why it arrived. That sentence is what people act on when they want less
 * mail, and without it the only available response is muting everything.
 *
 * `unsubscribed` is kept as a row rather than a deletion, so a later comment
 * does not quietly resubscribe somebody who opted out.
 */
export default defineModel({
  name: 'NotificationSubscription',
  table: 'notification_subscriptions',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'notification_subscriptions_subject_index', columns: ['subject_type', 'subject_id'] },
    { name: 'notification_subscriptions_user_index', columns: ['user_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 40 },
  },

  // Cascades, like the inbox entries it produces. A subscription is a standing
  // instruction to notify somebody, and one belonging to an account that no
  // longer exists can only ever produce rows nobody can read. The delivery log
  // is the deliberate exception - it records what was sent, which outlives the
  // account it was sent to.
  belongsTo: [{ model: 'User', onDelete: 'cascade' }],

  attributes: {
    user_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    subject_type: {
      order: 2,
      fillable: true,
      validation: { rule: schema.enum(['issue', 'pull_request', 'repository']) },
      factory: faker => faker.helpers.arrayElement(['issue', 'pull_request', 'repository']),
    },

    subject_id: {
      order: 3,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: faker => faker.number.int({ min: 1, max: 20 }),
    },

    reason: {
      order: 4,
      fillable: true,
      validation: {
        rule: schema.enum([
          'review_requested',
          'assigned',
          'mentioned',
          'team_mention',
          'author',
          'participating',
          'watching',
        ]),
      },
      factory: faker => faker.helpers.arrayElement(['author', 'participating', 'watching', 'mentioned']),
    },

    unsubscribed: {
      order: 5,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },
  },
} as const)
