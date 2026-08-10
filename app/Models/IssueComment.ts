import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A comment on an issue or a pull request.
 *
 * Polymorphic on purpose: a comment does not care which it is attached to, and
 * the pull request conversation reuses this rather than growing a parallel
 * table that drifts.
 */
export default defineModel({
  name: 'IssueComment',
  table: 'issue_comments',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'issue_comments_subject_index', columns: ['commentable_type', 'commentable_id'] },
    // The import's idempotency key. Without it, a resumed import cannot tell
    // "the same comment again" from "a new comment", and duplicates every row
    // it re-reads.
    { name: 'issue_comments_external_index', columns: ['external_id'] },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 60 },
  },

  belongsTo: [{ model: 'Issue', foreignKey: 'commentable_id' }, { model: 'User', foreignKey: 'author_id' }],

  attributes: {
    commentable_type: {
      order: 1,
      fillable: true,
      default: 'issue',
      validation: { rule: schema.enum(['issue', 'pull_request']) },
      factory: () => 'issue',
    },

    commentable_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /**
     * The local author, when there is one.
     *
     * Optional, because a mirrored comment is written by somebody who usually
     * has no account here - the same rule `Issue`, `PullRequest` and
     * `ReviewComment` already follow. It was required, which made importing an
     * issue's conversation impossible and left the column dangling for every
     * seeded row whose user went away.
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
      factory: faker => faker.lorem.paragraph(),
    },

    edited_at: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },

    edited_by_id: {
      order: 6,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
    /**
     * The upstream author, when there is no local account for them.
     *
     * Moves with `author_id`: exactly one of the two is ever set. A mirrored
     * conversation is written by people who mostly have no account here, and
     * attaching their words to a local user because the handles happen to match
     * puts words in somebody's mouth. The name is still shown, so the author is
     * visible without being claimed.
     */
    external_author: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().max(120) },
      factory: () => null,
    },

    /**
     * The id this comment had wherever it was imported from.
     *
     * **What makes an import resumable.** A comment carries no other stable
     * identity: two people can write the same words on the same issue in the
     * same minute, so matching on body and time would collapse them into one,
     * and matching on nothing duplicates every comment the importer re-reads
     * after an interruption. `review_comments` has had this column since it was
     * written and it is the same argument.
     */
    external_id: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string().max(120) },
      factory: () => null,
    },
  },
} as const)
