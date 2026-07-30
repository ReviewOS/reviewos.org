import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A conversation anchored to a place in a diff.
 *
 * The anchor is a path, a line, a side, and the commit it was written against.
 * Keeping the original commit is what lets the thread survive a force-push: the
 * line is found again by tracking it through the intervening diffs, and when it
 * is genuinely gone the thread is marked outdated and stays readable rather
 * than being dropped.
 *
 * `side` is which half of the diff the line belongs to: `left` is the version
 * being replaced, `right` the version proposed.
 */
export default defineModel({
  name: 'ReviewThread',
  table: 'review_threads',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'review_threads_pr_index', columns: ['pull_request_id'] },
    { name: 'review_threads_path_index', columns: ['pull_request_id', 'path'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 30 },
  },

  belongsTo: ['PullRequest'],

  attributes: {
    pull_request_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    path: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(1024) },
      factory: faker => `src/${faker.hacker.noun()}.ts`,
    },

    /** The line as it stands now, or null once the thread is outdated. */
    line: {
      order: 3,
      fillable: true,
      validation: { rule: schema.number() },
      factory: faker => faker.number.int({ min: 1, max: 400 }),
    },

    /** Set for a comment spanning several lines. */
    start_line: {
      order: 4,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    side: {
      order: 5,
      fillable: true,
      default: 'right',
      validation: { rule: schema.enum(['left', 'right']) },
      factory: () => 'right',
    },

    /** The line number in the commit the thread was written against. */
    original_line: {
      order: 6,
      fillable: true,
      validation: { rule: schema.number() },
      factory: faker => faker.number.int({ min: 1, max: 400 }),
    },

    original_commit_sha: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: faker => faker.git.commitSha(),
    },

    resolved: {
      order: 8,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: faker => faker.datatype.boolean(),
    },

    resolved_by_id: {
      order: 9,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** The line no longer exists in the current head. */
    outdated: {
      order: 10,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },
  },
} as const)
