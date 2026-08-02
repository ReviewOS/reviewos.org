import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One reviewer's verdict.
 *
 * `commit_sha` records what was reviewed. That is what makes a review
 * dismissible when new commits land: without it, an approval of one version
 * silently vouches for whatever arrives later.
 *
 * A review stays `pending` while its author works through the diff, and its
 * comments stay invisible to everyone else until it is submitted. Reviewing
 * should not mean sending a notification per line.
 */
export default defineModel({
  name: 'PullRequestReview',
  table: 'pull_request_reviews',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'pr_reviews_pr_index', columns: ['pull_request_id'] },
    { name: 'pr_reviews_reviewer_index', columns: ['pull_request_id', 'reviewer_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 25 },
  },

  belongsTo: ['PullRequest', { model: 'User', foreignKey: 'reviewer_id' }],

  attributes: {
    pull_request_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /**
     * The local reviewer, when there is one.
     *
     * Optional for the same reason an author is: a mirrored review was left by
     * somebody who usually has no account here, and a required column made
     * importing one impossible.
     */
    reviewer_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    state: {
      order: 3,
      fillable: true,
      default: 'pending',
      validation: { rule: schema.enum(['pending', 'approved', 'changes_requested', 'commented', 'dismissed']) },
      factory: faker => faker.helpers.arrayElement(['approved', 'changes_requested', 'commented']),
    },

    body: {
      order: 4,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: faker => faker.lorem.sentence(),
    },

    /** The head the reviewer actually read. */
    commit_sha: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: faker => faker.git.commitSha(),
    },

    submitted_at: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string() },
      factory: faker => faker.date.recent().toISOString(),
    },

    dismissed_reason: {
      order: 7,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: () => null,
    },
    /**
     * The upstream author, when there is no local account for them.
     *
     * Moves with `reviewer_id`: exactly one of the two is ever set. A mirrored
     * conversation is written by people who mostly have no account here, and
     * attaching their words to a local user because the handles happen to match
     * puts words in somebody's mouth. The name is still shown, so the author is
     * visible without being claimed.
     */
    external_author: {
      order: 9,
      fillable: true,
      validation: { rule: schema.string().max(120) },
      factory: () => null,
    },
  },
} as const)
