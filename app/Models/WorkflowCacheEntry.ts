import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A snapshot of a workspace after its dependencies were installed.
 *
 * The dependency cache, as a snapshot rather than as a keyed archive of a named
 * directory. It is the better primitive for the common case: nobody has to know
 * which paths their package manager writes to, which is the knowledge every
 * `actions/cache` bug report turns out to be missing.
 *
 * **The row points at a digest, the same way an artifact does.** Two branches
 * whose lockfiles agree produce identical bytes and cost one file, which is the
 * ordinary case on a repository where most pull requests change no dependencies
 * at all.
 *
 * ## Scope is not a label
 *
 * `scope` is a security boundary and the rules behind it live in
 * [`cacheScope.ts`](../Actions/Workflow/cacheScope.ts). A run restores from its
 * own scope and from the default branch, and writes only to its own - so a
 * fork's pull request gets a `fork/<number>` scope that no branch of this
 * repository ever reads. A cache is a directory one run writes and another
 * executes out of, which makes a shared scope the shortest path from "somebody
 * opened a pull request" to "their code ran on the default branch".
 *
 * ## Why `last_used_at` and not just `created_at`
 *
 * Collection is by size and age, and age measured from the write would drop the
 * entry a hundred runs a day restore in favour of one written this morning and
 * never read. What makes a cache worth its disk is being restored.
 */
export default defineModel({
  name: 'WorkflowCacheEntry',
  table: 'workflow_cache_entries',
  primaryKey: 'id',
  autoIncrement: true,

  belongsTo: [{ model: 'Repository', onDelete: 'cascade' }],

  indexes: [
    /*
     * The lookup, and the thing that makes a save idempotent.
     *
     * A restore asks for one key across the scopes it may read, and a runner
     * that did not hear its save answered uploads again - at-least-once, so
     * that will happen. Without this the repository grows two rows for one
     * snapshot and the next restore has to guess which.
     */
    { name: 'workflow_cache_entries_key_index', columns: ['repository_id', 'scope', 'cache_key'], unique: true },
    // Collection, across every repository at once: oldest unused first.
    { name: 'workflow_cache_entries_used_index', columns: ['last_used_at'] },
    // What a repository is spending, which is the number a policy is written
    // against and the one an operator is shown before anything is deleted.
    { name: 'workflow_cache_entries_repository_index', columns: ['repository_id'] },
    // Whether any row still references a digest before its bytes are removed.
    { name: 'workflow_cache_entries_digest_index', columns: ['digest'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  attributes: {
    /**
     * The repository this belongs to.
     *
     * The shard key, and the reason it is first: a cache is per repository by
     * definition - two repositories sharing one would be the poisoning problem
     * with the blast radius of the whole instance.
     */
    repository_id: {
      order: 1,
      fillable: true,
      required: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    /**
     * Whose cache this is: a full ref, or `fork/<pull request>`.
     *
     * Never a short branch name. A short name is ambiguous between a branch and
     * a tag, and this is a boundary - an ambiguity here is one resolved
     * differently by two callers, which is how a fork's entry ends up somewhere
     * a branch reads.
     */
    scope: {
      order: 2,
      fillable: true,
      required: true,
      validation: { rule: schema.string().max(255).required() },
      factory: () => 'refs/heads/main',
    },

    /**
     * The derived key: lockfiles, runtime, architecture, image.
     *
     * Derived rather than written by an author, so a lockfile change
     * invalidates it without anybody maintaining a key expression. See
     * [`cacheKey.ts`](../Actions/Workflow/cacheKey.ts).
     */
    cache_key: {
      order: 3,
      fillable: true,
      required: true,
      validation: { rule: schema.string().max(64).required() },
      factory: () => 'b'.repeat(64),
    },

    /**
     * The key an author wrote, when one did.
     *
     * Empty for a workspace snapshot, whose key nobody writes. Present for the
     * `actions/cache` form, and present because that form's `restore-keys` are
     * **prefix** matches - `deps-linux-` finding `deps-linux-abc123` - which a
     * hashed key cannot answer. So the hash above stays the unique identity and
     * this is what a prefix search reads.
     *
     * Longer than the hash for the obvious reason: people write long keys, and
     * a key silently truncated to 64 characters is two caches that collide.
     */
    label: {
      order: 35,
      fillable: true,
      validation: { rule: schema.string().max(512) },
      factory: () => null,
    },

    /** SHA-256 of the archive. The bytes' address, and how two scopes share a file. */
    digest: {
      order: 4,
      fillable: true,
      required: true,
      validation: { rule: schema.string().max(64).required() },
      factory: () => 'c'.repeat(64),
    },

    /** Where the bytes went in the blob store, recorded rather than derived. */
    blob_key: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: () => null,
    },

    size_bytes: {
      order: 6,
      fillable: true,
      required: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    /**
     * When it was last restored, not when it was written.
     *
     * Collection reads this: an entry a hundred runs a day restore should
     * outlive one written this morning and never read again.
     */
    last_used_at: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },

    /** How many times it has been restored, for the number an operator is shown. */
    restores: {
      order: 8,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    /**
     * The run that wrote it.
     *
     * Nullable and deliberately not a cascade: a cache outliving the run that
     * produced it is the entire point, and deleting old runs should not throw
     * away the install every branch is starting from.
     */
    workflow_run_id: {
      order: 9,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
})
