import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Something somebody does not want to hear about right now.
 *
 * One polymorphic model rather than a flag per place, because muting a
 * repository, an organization, a pull request, and an issue are the same
 * decision at different scopes, and a boolean column on each of those tables
 * would need four sets of rules that drift apart.
 *
 * Muting is not unwatching. The subscription stays intact, so unmuting restores
 * exactly what was there, and the in-app inbox still records what arrived while
 * muted. That is what makes muting safe enough that people use it instead of
 * leaving.
 *
 * A null `expires_at` is indefinite. Everything else ends by itself, which is
 * the point: "mute until Monday" is a decision somebody can afford to make.
 */
export default defineModel({
  name: 'NotificationMute',
  table: 'notification_mutes',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'notification_mutes_user_index', columns: ['user_id'] },
    { name: 'notification_mutes_subject_index', columns: ['subject_type', 'subject_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 15 },
  },

  belongsTo: ['User'],

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
      validation: { rule: schema.enum(['repository', 'organization', 'issue', 'pull_request']) },
      factory: faker => faker.helpers.arrayElement(['repository', 'issue', 'pull_request']),
    },

    subject_id: {
      order: 3,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: faker => faker.number.int({ min: 1, max: 20 }),
    },

    /** Null is indefinite. */
    expires_at: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },
  },
} as const)
