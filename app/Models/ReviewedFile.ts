import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One file a reviewer has finished with, on one pull request.
 *
 * Ticking a file folds it away, and the value of that is entirely in it being
 * remembered: a review of two hundred files is not one sitting, and a reviewer
 * who comes back to find every file open again has lost the only record of
 * where they were.
 *
 * Kept per pull request rather than per path. A key of just the path would tick
 * a file on every other pull request that touches it, which looks exactly like
 * the feature working right up until somebody notices a file they have never
 * opened is already ticked.
 *
 * `head_sha` is what the reviewer actually read, and it is recorded rather than
 * acted on. The obvious use - call the tick stale when the head has moved - is
 * wrong as stated: the head is one sha for the whole pull request, so any push
 * would unmark every file including the ones it did not touch. Doing it
 * properly means asking git whether *this file* changed between the two shas,
 * which is a per-file question and belongs with the incremental diff in phase
 * 4. Storing it now is what makes that possible later; nothing reads it yet.
 */
export default defineModel({
  name: 'ReviewedFile',
  table: 'reviewed_files',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'reviewed_files_repository_index', columns: ['repository_id'] },
    // One answer per reviewer per file. Two rows would mean the product holds
    // two opinions about whether somebody has read something.
    { name: 'reviewed_files_pr_user_path_index', columns: ['pull_request_id', 'reviewer_id', 'path'], unique: true },
    // Reading the whole set for one reviewer is the request the page makes on
    // load, and it is the only one that matters for latency.
    { name: 'reviewed_files_pr_user_index', columns: ['pull_request_id', 'reviewer_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 20 },
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

    path: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required().max(1024) },
      factory: faker => `src/${faker.hacker.noun()}.ts`,
    },

    /** The head the reviewer read, so a later push can mark the tick stale. */
    head_sha: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: faker => faker.git.commitSha(),
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
