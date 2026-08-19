import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A comment somebody started writing and has not sent.
 *
 * Not a `ReviewComment`: it has never been posted, nobody else can see it, and
 * it has no thread. It is the sentence that took the longest to write, kept
 * safe against a navigation, a reload, a closed laptop, and a different
 * machine tomorrow morning. Local storage covers the first two and none of the
 * others, which is why this row exists.
 *
 * One per reviewer per pull request, because that is what the viewer holds: it
 * allows a single draft open at a time, so there is never a second to keep.
 * Going draft-per-line later is a change to this model and a generated
 * migration, and until then a unique row is the honest shape - a table that can
 * hold several while the interface can only restore one leaves the others to
 * surface at some arbitrary later moment.
 *
 * The anchor travels with the text. A draft put back on the wrong line is a
 * comment about code it is not about, so the path, the side and the range are
 * stored beside the body rather than inferred on the way back.
 */
export default defineModel({
  name: 'ReviewDraft',
  table: 'review_drafts',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'review_drafts_repository_index', columns: ['repository_id'] },
    { name: 'review_drafts_pr_author_index', columns: ['pull_request_id', 'author_id'], unique: true },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 10 },
  },

  belongsTo: [
    { model: 'PullRequest', onDelete: 'cascade' },
    { model: 'User', foreignKey: 'author_id', onDelete: 'cascade' },
  ],

  attributes: {
    pull_request_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    author_id: {
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

    /** Which half of the diff: `left` is what is being replaced. */
    side: {
      order: 4,
      fillable: true,
      default: 'right',
      validation: { rule: schema.enum(['left', 'right']) },
      factory: () => 'right',
    },

    /** The first line of the range, and `to_line` the last. Equal for one line. */
    from_line: {
      order: 5,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: faker => faker.number.int({ min: 1, max: 400 }),
    },

    to_line: {
      order: 6,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: faker => faker.number.int({ min: 1, max: 400 }),
    },

    body: {
      order: 7,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string().required() },
      factory: faker => faker.lorem.sentence(),
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
