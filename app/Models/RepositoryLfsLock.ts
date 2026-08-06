import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A lock on one file, held by one person.
 *
 * A binary file cannot be merged, so two people editing one is not a conflict
 * to resolve later - it is one of them losing work. This is the row that says
 * "I have this file" before that happens rather than after.
 *
 * In the database rather than in memory because a lock that a deploy forgets is
 * a lock somebody was relying on. The decisions about who may take and break
 * one live in `ts-git-lfs`; this is only where they are kept.
 */
export default defineModel({
  name: 'RepositoryLfsLock',
  table: 'repository_lfs_locks',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // One lock per path per repository, and the database is what enforces it.
    // Checking first and inserting after is a race two people pushing at once
    // will find, and the whole point of a lock is that it cannot be held twice.
    { name: 'repository_lfs_locks_repo_path_index', columns: ['repository_id', 'path'], unique: true },
    { name: 'repository_lfs_locks_lock_id_index', columns: ['lock_id'], unique: true },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  // Repository-scoped: the lock means nothing without the repository, so the
  // database removes it rather than the application remembering to.
  belongsTo: [{ model: 'Repository', onDelete: 'cascade' }],

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    /**
     * The id a client sees, and the only one it ever sees.
     *
     * Separate from the primary key on purpose: the id is echoed back in every
     * unlock request, and a sequential integer would let anybody with one lock
     * id guess every other lock on the server.
     */
    lock_id: {
      order: 2,
      unique: true,
      fillable: true,
      validation: { rule: schema.string().required().max(64) },
      factory: faker => faker.string.uuid(),
    },

    path: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required().max(4096) },
      factory: faker => `assets/${faker.system.fileName()}`,
    },

    owner_id: {
      order: 4,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    /**
     * The name shown to whoever is refused the lock.
     *
     * Stored rather than joined, because it is what the client displays and it
     * should keep saying who held the lock even if that account is later
     * renamed or removed.
     */
    owner_name: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().required().max(120) },
      factory: faker => faker.internet.username(),
    },

    /** The ref the lock was taken against, when the client named one. */
    ref: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: () => null,
    },

    /** ISO 8601, which the spec requires and clients display verbatim. */
    locked_at: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().required().max(64) },
      factory: () => new Date().toISOString(),
    },
  },
} as const)
