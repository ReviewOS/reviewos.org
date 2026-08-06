import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A mirror of a repository hosted somewhere else.
 *
 * The local name is deliberately not derived from the remote: `stacksjs/stacks`
 * on GitHub is `stacks/stacks` here, so the mapping is stored per mirror and
 * chosen when the mirror is created. Deriving it would make the two names one
 * fact, and they are two.
 *
 * `last_error` and `last_synced_at` live here rather than in a log because the
 * repository page has to show them. A mirror that silently stopped updating is
 * worse than one that visibly failed - the reader trusts what they are looking
 * at either way.
 */
export default defineModel({
  name: 'RepositoryMirror',
  table: 'repository_mirrors',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'repository_mirrors_repository_index', columns: ['repository_id'] },
    // The sweep asks for enabled mirrors ordered by when they were last synced,
    // so that pair is the index that matters.
    { name: 'repository_mirrors_due_index', columns: ['enabled', 'last_synced_at'] },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 3 },
  },

  belongsTo: [{ model: 'Repository', foreignKey: 'repository_id', onDelete: 'cascade' }],

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: faker => faker.number.int({ min: 1, max: 8 }),
    },

    direction: {
      order: 2,
      fillable: true,
      default: 'pull',
      validation: { rule: schema.enum(['pull', 'push']) },
      factory: () => 'pull',
    },

    provider: {
      order: 3,
      fillable: true,
      default: 'github',
      validation: { rule: schema.enum(['github', 'gitlab', 'git']) },
      factory: () => 'github',
    },

    remote_url: {
      order: 4,
      fillable: true,
      required: true,
      validation: { rule: schema.string().max(500) },
      factory: faker => `https://github.com/${faker.internet.username().toLowerCase()}/${faker.lorem.word()}.git`,
    },

    /** Owner as it is spelled upstream, which the local owner need not match. */
    remote_owner: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(120) },
      factory: faker => faker.internet.username().toLowerCase(),
    },

    remote_name: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(120) },
      factory: faker => faker.lorem.word(),
    },

    /**
     * Reference to a stored credential, never the credential itself. A token
     * copied in here would be in every backup and every database dump.
     */
    credential_ref: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().max(200) },
      factory: () => null,
    },

    /** Seconds between sweeps. The webhook is what makes it feel immediate. */
    interval_seconds: {
      order: 8,
      fillable: true,
      default: 900,
      validation: { rule: schema.number().min(60) },
      factory: () => 900,
    },

    enabled: {
      order: 9,
      fillable: true,
      default: true,
      validation: { rule: schema.boolean() },
      factory: () => true,
    },

    last_synced_at: {
      order: 10,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },

    /** Head of the default branch at the last sync, to spot a rewrite. */
    last_sha: {
      order: 11,
      fillable: true,
      validation: { rule: schema.string().max(64) },
      factory: () => null,
    },

    last_error: {
      order: 12,
      fillable: true,
      validation: { rule: schema.string().max(1000) },
      factory: () => null,
    },

    /**
     * Consecutive failures, so backoff can widen and a mirror that will never
     * work stops being retried every fifteen minutes forever.
     */
    failure_count: {
      order: 13,
      fillable: true,
      default: 0,
      validation: { rule: schema.number().min(0) },
      factory: () => 0,
    },

    /**
     * Whether to import issues, pull requests and review threads as well as
     * commits.
     *
     * Separate from `enabled` because it costs differently: commits come from
     * one `git fetch`, while metadata is many API calls against a rate limit
     * that is shared across every mirror using the same token. A mirror of a
     * huge repository may reasonably want the code and not the backlog.
     */
    sync_metadata: {
      order: 14,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    last_metadata_sync_at: {
      order: 15,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },

    /**
     * Why the last metadata sync fell short, kept apart from `last_error`.
     *
     * A rate limit that stopped the issue import says nothing about whether the
     * commits are current, and folding both into one field would make the
     * repository page claim the mirror is broken when only half of it is.
     */
    metadata_error: {
      order: 16,
      fillable: true,
      validation: { rule: schema.string().max(1000) },
      factory: () => null,
    },

    /** Consecutive metadata failures, so the retry interval can widen. */
    metadata_failure_count: {
      order: 17,
      fillable: true,
      default: 0,
      validation: { rule: schema.number().min(0) },
      factory: () => 0,
    },
  },
})
