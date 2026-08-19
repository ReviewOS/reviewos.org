import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A requested reviewer: a person, or a team standing in for its members.
 *
 * Requests from CODEOWNERS land here too, so "who was asked" reads the same
 * whether a human or a file did the asking.
 */
export default defineModel({
  name: 'PullRequestReviewer',
  table: 'pull_request_reviewers',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'pull_request_reviewers_repository_index', columns: ['repository_id'] },
    { name: 'pr_reviewers_pr_index', columns: ['pull_request_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 20 },
  },

  belongsTo: [
    'PullRequest',
    { model: 'User', foreignKey: 'reviewer_id' },
    { model: 'User', foreignKey: 'requested_by_id', relationName: 'requestedBy', onDelete: 'set null' },
  ],

  attributes: {
    pull_request_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    reviewer_type: {
      order: 2,
      fillable: true,
      default: 'user',
      validation: { rule: schema.enum(['user', 'team']) },
      factory: () => 'user',
    },

    reviewer_id: {
      order: 3,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    requested_by_id: {
      order: 4,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** True when CODEOWNERS asked rather than a person. */
    from_code_owners: {
      order: 5,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /**
     * When the request was answered by a submitted review.
     *
     * Kept rather than deleting the row, so "who was asked, and did they
     * reply" survives; a request that quietly disappeared on submit would
     * leave no record that the reviewer was ever asked.
     */
    responded_at: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },

    /**
     * The repository this belongs to, copied from its pull request.
     *
     * Denormalized, and the duplication is the point: this is the column a
     * sharded keyspace routes on, and Vitess cannot follow a foreign key to
     * find it. Without it this table lands in the unsharded keyspace, and every
     * transaction touching it and its pull request crosses keyspaces - the one
     * thing sharding by repository was chosen to avoid.
     *
     * Written where the row is created, from the parent already in hand.
     * `buddy db:keyspaces --check` is what notices when it is not.
     */
    repository_id: {
      order: 90,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
} as const)
