import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * An issue.
 *
 * `number` is per repository and gaps are not acceptable: `#12` appears in
 * commit messages, in other issues, and in people's memory. It is allocated
 * from a counter on the repository row in the same transaction as the insert,
 * and issues share that counter with pull requests so a number means one thing.
 */
export default defineModel({
  name: 'Issue',
  table: 'issues',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'issues_repo_number_index', columns: ['repository_id', 'number'] },
    { name: 'issues_repo_state_index', columns: ['repository_id', 'state'] },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'number', 'title', 'state'],
      searchable: ['title', 'body'],
      sortable: ['created_at', 'updated_at'],
      filterable: ['state'],
    },
    useSeeder: { count: 30 },
  },

  // `milestone_id` is a foreign key and was not declared as one, so no
  // constraint was generated for it and nothing stopped an issue pointing at a
  // milestone that had been deleted. `set null` rather than cascade: deleting a
  // milestone means the issues in it no longer have one, not that the issues go
  // with it.
  belongsTo: [
    { model: 'Repository', onDelete: 'cascade' },
    { model: 'User', foreignKey: 'author_id' },
    { model: 'Milestone', foreignKey: 'milestone_id', onDelete: 'set null' },
    // Who closed it is worth keeping and not worth keeping a row alive for:
    // the issue outlives the account, and the field goes blank.
    { model: 'User', foreignKey: 'closed_by_id', relationName: 'closedBy', onDelete: 'set null' },
  ],

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    number: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: faker => faker.number.int({ min: 1, max: 200 }),
    },

    title: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required().min(1).max(255) },
      factory: faker => faker.hacker.phrase(),
    },

    body: {
      order: 4,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: faker => faker.lorem.paragraphs(2),
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
      order: 5,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    state: {
      order: 6,
      fillable: true,
      default: 'open',
      validation: { rule: schema.enum(['open', 'closed']) },
      factory: faker => faker.helpers.arrayElement(['open', 'closed']),
    },

    state_reason: {
      order: 7,
      fillable: true,
      validation: { rule: schema.enum(['completed', 'not_planned', 'duplicate']) },
      factory: () => 'completed',
    },

    closed_at: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string() },
      factory: faker => faker.date.recent().toISOString(),
    },

    closed_by_id: {
      order: 9,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    milestone_id: {
      order: 10,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    locked: {
      order: 11,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    comments_count: {
      order: 12,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: faker => faker.number.int({ min: 0, max: 20 }),
    },

    /** Set when the row is a pull request, so both share one number sequence. */
    is_pull_request: {
      order: 13,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /**
     * Who wrote this upstream, when the mirror could not link them to a local
     * user. `author_id` stays null in that case: attributing a comment to a
     * local account that happens to share a handle puts words in someone's
     * mouth, and two people with the same name is ordinary. The name is still
     * shown, so the author is visible without being claimed.
     */
    external_author: {
      order: 14,
      fillable: true,
      validation: { rule: schema.string().max(120) },
      factory: () => null,
    },
  },
} as const)
