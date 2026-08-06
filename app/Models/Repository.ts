import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A git repository.
 *
 * Owned polymorphically: `owner_type` is `user` or `organization`, and
 * `owner_id` points into that table. A repository's URL is
 * `/{owner handle}/{name}`, so name is unique per owner rather than globally.
 *
 * The counter columns are denormalised on purpose. A forge shows star and issue
 * counts on every listing, and counting rows for each one turns a repository
 * list into dozens of aggregate queries. Every writer updates the counter in
 * the same transaction as the row it counts.
 */
export default defineModel({
  name: 'Repository',
  table: 'repositories',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // Unique, not merely indexed. Every path that creates a repository under a
    // name - create, fork, rename, transfer - checks first that the name is
    // free, and every one of those checks is a read followed by a write with a
    // gap in between. Two requests arriving together both find the name free.
    // The constraint is what actually holds the rule; the checks exist to turn
    // it into a sentence rather than a database error.
    { name: 'repositories_owner_name_index', columns: ['owner_type', 'owner_id', 'name'], unique: true },
    { name: 'repositories_pushed_at_index', columns: ['pushed_at'] },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'name', 'description', 'visibility'],
      searchable: ['name', 'description'],
      sortable: ['created_at', 'pushed_at', 'stars_count'],
      filterable: ['visibility'],
    },
    useSeeder: { count: 8 },
  },

  // A fork points at what it was forked from, and forks outlive their parent:
  // deleting a repository detaches its forks rather than taking them with it.
  // `app/Actions/Repo/purge.ts` does exactly this by hand today, which is the
  // application doing what the column can say for itself.
  //
  // Note this is the one relation here that is *not* declared for the sake of a
  // cascade - it is declared so a fork cannot point at a repository that is
  // gone, which nothing prevented before.
  belongsTo: [{ model: 'Repository', foreignKey: 'parent_id', relationName: 'parent', onDelete: 'set null' }],

  attributes: {
    owner_type: {
      order: 1,
      fillable: true,
      validation: { rule: schema.enum(['user', 'organization']) },
      factory: faker => faker.helpers.arrayElement(['user', 'organization']),
    },

    owner_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: faker => faker.number.int({ min: 1, max: 4 }),
    },

    name: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required().min(1).max(100) },
      factory: faker => faker.hacker.noun().toLowerCase(),
    },

    description: {
      order: 4,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string().max(500) },
      factory: faker => faker.company.catchPhrase(),
    },

    visibility: {
      order: 5,
      fillable: true,
      default: 'public',
      validation: { rule: schema.enum(['public', 'private', 'internal']) },
      factory: faker => faker.helpers.arrayElement(['public', 'private']),
    },

    default_branch: {
      order: 6,
      fillable: true,
      default: 'main',
      validation: { rule: schema.string().max(255) },
      factory: () => 'main',
    },

    /** Where the bare repository lives, relative to the repository root. */
    disk_path: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().max(512) },
      factory: faker => `${faker.internet.username().toLowerCase()}/${faker.hacker.noun().toLowerCase()}.git`,
    },

    is_fork: {
      order: 8,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    parent_id: {
      order: 9,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    is_archived: {
      order: 10,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    is_template: {
      order: 11,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    size_kb: {
      order: 12,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: faker => faker.number.int({ min: 0, max: 50000 }),
    },

    stars_count: {
      order: 13,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: faker => faker.number.int({ min: 0, max: 500 }),
    },

    forks_count: {
      order: 14,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: faker => faker.number.int({ min: 0, max: 50 }),
    },

    open_issues_count: {
      order: 15,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: faker => faker.number.int({ min: 0, max: 40 }),
    },

    /**
     * Issues and pull requests share one sequence, so `#12` is unambiguous.
     * Allocated in the same transaction as the row it numbers.
     */
    issue_counter: {
      order: 16,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    pushed_at: {
      order: 17,
      fillable: true,
      validation: { rule: schema.string() },
      factory: faker => faker.date.recent().toISOString(),
    },
  },
} as const)
