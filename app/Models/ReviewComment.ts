import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A message in a review thread.
 *
 * `review_id` is null for a reply written outside a formal review, which is how
 * most conversation after the first round happens.
 */
export default defineModel({
  name: 'ReviewComment',
  table: 'review_comments',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'review_comments_thread_index', columns: ['review_thread_id'] },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 50 },
  },

  belongsTo: ['ReviewThread', { model: 'User', foreignKey: 'author_id' }, { model: 'PullRequestReview', foreignKey: 'review_id' }],

  attributes: {
    review_thread_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    review_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    author_id: {
      order: 3,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    body: {
      order: 4,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string().required() },
      factory: faker => faker.lorem.sentence(),
    },

    /** A suggested replacement the author can commit in one click. */
    suggestion: {
      order: 5,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: () => null,
    },

    edited_at: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },
  },
} as const)
