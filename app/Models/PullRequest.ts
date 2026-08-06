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

  belongsTo: [
    { model: 'Repository', onDelete: 'cascade' },
    { model: 'User', foreignKey: 'author_id' },
    // Who merged it, kept as long as the account is. The merge itself is in
    // the git history either way.
    { model: 'User', foreignKey: 'merged_by_id', relationName: 'mergedBy', onDelete: 'set null' },
    // A stack is pull requests that merge in order. Removing one does not
    // remove what was stacked on it - it un-stacks it, which is the same thing
    // the application does by hand today.
    { model: 'PullRequest', foreignKey: 'stack_parent_id', relationName: 'stackParent', onDelete: 'set null' },
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
      factory: faker => faker.lorem.paragraph(),
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

    /**
     * Set when the pull request is closed without merging, and cleared when it
     * is reopened. Kept separate from `merged_at` because "withdrawn" and
     * "landed" are different outcomes and a single timestamp cannot say which.
     */
    closed_at: {
      order: 21,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },

    closed_by_id: {
      order: 22,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /**
     * The two commits `mergeable_state` was computed from.
     *
     * Mergeability is a fact about a pair of commits, so caching it against
     * them is what makes "invalidated on push" fall out for free: the moment
     * either side moves, the stored answer no longer matches and is recomputed.
     * No hook has to remember to clear anything.
     */
    mergeable_base_sha: {
      order: 23,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    mergeable_head_sha: {
      order: 24,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    /**
     * The conflicting paths, newline separated.
     *
     * A text column rather than rows, which is the opposite of the rule
     * elsewhere in this codebase, and deliberately: this is a cache of a
     * computation, replaced wholesale whenever either sha moves, and never
     * joined against or queried by path. Newlines separate them because a path
     * may contain a comma and may not contain a newline.
     *
     * The length is what makes this `text` rather than `varchar(255)`. A merge
     * that conflicts in thirty files would silently fail to insert otherwise,
     * which is exactly how the framework's own query log broke on Postgres.
     */
    mergeable_conflicts: {
      order: 25,
      fillable: true,
      validation: { rule: schema.string().max(65535) },
      factory: () => null,
    },

    /** Upstream author when the mirror could not link them. See `Issue`. */
    external_author: {
      order: 26,
      fillable: true,
      validation: { rule: schema.string().max(120) },
      factory: () => null,
    },
  },
} as const)
