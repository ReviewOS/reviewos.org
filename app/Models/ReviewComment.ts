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
    // Every re-sync looks up each incoming comment by its upstream id, so this
    // is the difference between one index scan and a table scan per comment.
    { name: 'review_comments_external_index', columns: ['external_id'] },
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

    /**
     * The local author, or null.
     *
     * Nullable because two ordinary things make it absent: an account that was
     * deleted, and a mirrored row whose upstream author is not linked to a
     * local user. In both cases `external_author` carries the name so the
     * author stays visible without being claimed by whoever the id would have
     * pointed at.
     */
    author_id: {
      order: 3,
      fillable: true,
      validation: { rule: schema.number() },
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

    /**
     * The upstream comment id, for mirrored comments.
     *
     * A review comment has no natural key - not path, not line, not body - so
     * without this a re-sync would insert every comment again rather than
     * recognise it. Numbers give issues and pull requests that identity for
     * free; comments need it stored.
     */
    external_id: {
      order: 7,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** Upstream author when the mirror could not link them. See `Issue`. */
    external_author: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string().max(120) },
      factory: () => null,
    },
  },
} as const)
