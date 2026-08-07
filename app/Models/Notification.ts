import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One entry in somebody's inbox, overriding the framework default.
 *
 * The default at `storage/framework/defaults/app/Models/Notification.ts`
 * declares `belongsTo: ['User']` and nothing came of it: the table is created
 * by the framework's guarantee path rather than from the model corpus, so no
 * constraint was ever generated and `notifications.user_id` pointed at nothing
 * in particular. Declaring the relation here, under `app/`, is what puts the
 * table in the corpus and the constraint in the SQL.
 *
 * `onDelete: 'cascade'` because an inbox entry for an account that no longer
 * exists is unreachable. The delivery log next door deliberately chooses
 * differently, and says why.
 */
export default defineModel({
  name: 'Notification',
  table: 'notifications',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 30,
    },
    useApi: {
      uri: 'notifications',
      routes: ['index', 'store', 'show', 'update', 'destroy'],
    },
  },

  belongsTo: [{ model: 'User', onDelete: 'cascade' }],

  attributes: {
    type: {
      required: true,
      fillable: true,
      validation: {
        rule: schema.string().max(255),
      },
      factory: faker => faker.helpers.arrayElement([
        'review.requested',
        'review.submitted',
        'pull_request.merged',
        'issue.opened',
      ]),
    },

    /**
     * JSON: the sentence, where it points, why it arrived, and the repository
     * it came from. `text` rather than the framework default's `varchar(255)`,
     * which a real notification exceeds routinely - a title, a URL and a
     * repository name are past 255 between them before anything is unusual, and
     * Postgres refuses an over-length varchar rather than truncating it. The
     * inbox is the channel that has to work when nothing else does, so the
     * failure mode here is the worst one available: the notification is lost at
     * insert, and the person it was about never learns there was one.
     */
    data: {
      required: true,
      fillable: true,
      type: 'text',
      validation: {
        rule: schema.string(),
      },
      factory: faker => JSON.stringify({
        body: faker.lorem.sentence(),
        source: 'system',
      }),
    },

    readAt: {
      required: false,
      fillable: true,
      validation: {
        rule: schema.timestamp(),
      },
      factory: (faker) => {
        if (faker.datatype.boolean())
          return faker.date.recent().toISOString().slice(0, 19).replace('T', ' ')

        return null
      },
    },
  },
} as const)
