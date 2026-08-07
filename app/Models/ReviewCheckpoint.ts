import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * "I have read this round", said explicitly, without a verdict.
 *
 * Last-looked is normally inferred: the later of a submitted review and a
 * viewed-file mark. That is right for the common case and has no way to say "I
 * caught up" - a reviewer who read everything and had nothing to add has left
 * neither record, and the incremental diff keeps offering them a round they
 * have already read. This row is that missing sentence.
 *
 * One row per reviewer per pull request, updated in place. The history of
 * catch-ups is not worth keeping: the question the incremental diff asks is
 * "where did this reader get to", and only the latest answer is the answer.
 */
export default defineModel({
  name: 'ReviewCheckpoint',
  table: 'review_checkpoints',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // One answer per reviewer. Two rows would mean the product holds two
    // opinions about where somebody got to.
    { name: 'review_checkpoints_pr_user_index', columns: ['pull_request_id', 'reviewer_id'], unique: true },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 10 },
  },

  belongsTo: [
    { model: 'PullRequest', onDelete: 'cascade' },
    { model: 'User', foreignKey: 'reviewer_id', onDelete: 'cascade' },
  ],

  attributes: {
    pull_request_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    reviewer_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** The head the reviewer declared themselves caught up to. */
    head_sha: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required().max(40) },
      factory: faker => faker.git.commitSha(),
    },
  },
} as const)
