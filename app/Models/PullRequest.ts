import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A proposed change.
 *
 * `number` comes from the same per-repository counter as issues, so `#12` means
 * one thing whether it is an issue or a pull request.
 *
 * `base_sha` is the merge base, not the base branch tip. That distinction is
 * the whole reason this project exists: diffing against the tip shows every
 * change made on the base since the branch left it, and attributes them to the
 * author of the pull request.
 *
 * `stack_parent_id` makes this pull request depend on another. A stacked pull
 * request diffs against its parent's head, so it shows only its own work.
 */
export default defineModel({
  name: 'PullRequest',
  table: 'pull_requests',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'pull_requests_repo_number_index', columns: ['repository_id', 'number'] },
    { name: 'pull_requests_repo_state_index', columns: ['repository_id', 'state'] },
    { name: 'pull_requests_stack_index', columns: ['stack_parent_id'] },
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
    useSeeder: { count: 20 },
  },

  belongsTo: ['Repository', { model: 'User', foreignKey: 'author_id' }],

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
      factory: faker => faker.lorem.paragraph(),
    },

    author_id: {
      order: 5,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    state: {
      order: 6,
      fillable: true,
      default: 'open',
      validation: { rule: schema.enum(['open', 'closed', 'merged']) },
      factory: faker => faker.helpers.arrayElement(['open', 'closed', 'merged']),
    },

    /** Null when the head branch is in this same repository. */
    head_repository_id: {
      order: 7,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    head_branch: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string().required().max(255) },
      factory: faker => `feature/${faker.hacker.noun()}`,
    },

    head_sha: {
      order: 9,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: faker => faker.git.commitSha(),
    },

    base_branch: {
      order: 10,
      fillable: true,
      default: 'main',
      validation: { rule: schema.string().required().max(255) },
      factory: () => 'main',
    },

    /** The merge base, recomputed whenever either side moves. */
    base_sha: {
      order: 11,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: faker => faker.git.commitSha(),
    },

    merge_commit_sha: {
      order: 12,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    merged_at: {
      order: 13,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },

    merged_by_id: {
      order: 14,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    draft: {
      order: 15,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    mergeable_state: {
      order: 16,
      fillable: true,
      default: 'unknown',
      validation: { rule: schema.enum(['unknown', 'clean', 'dirty', 'blocked', 'behind']) },
      factory: () => 'unknown',
    },

    stack_parent_id: {
      order: 17,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    additions: {
      order: 18,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: faker => faker.number.int({ min: 0, max: 900 }),
    },

    deletions: {
      order: 19,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: faker => faker.number.int({ min: 0, max: 400 }),
    },

    changed_files: {
      order: 20,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: faker => faker.number.int({ min: 1, max: 40 }),
    },
  },
} as const)
