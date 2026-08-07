import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A key that can reach exactly one repository, and usually only read it.
 *
 * The case it exists for is a machine: a CI runner or a server that needs to
 * clone one repository and nothing else. A personal key would give it
 * everything its owner can reach, and an access token is the wrong shape - a
 * token belongs to a person, expires on their schedule, and dies with their
 * account. A deploy key belongs to the repository.
 *
 * **Read-only by default.** Almost every use is a clone, and the one that is
 * not should have to be asked for: a key that can write is a key that can
 * rewrite history from a build server nobody is watching.
 *
 * Scoped by the row, not by a check somewhere. There is no `user_id` here on
 * purpose - a deploy key authenticates as *the repository's*, so there is no
 * account to intersect with and no way for it to inherit anything.
 */
export default defineModel({
  name: 'DeployKey',
  table: 'deploy_keys',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // Unique across every repository, and across `ssh_keys` too - the second
    // half is enforced in `app/Actions/Keys/deploy.ts`, because the database
    // cannot span two tables. A fingerprint that resolved to both an account
    // and a repository would make "who pushed this" unanswerable, and the SSH
    // transport picks an identity from the fingerprint alone.
    { name: 'deploy_keys_fingerprint_index', columns: ['fingerprint'], unique: true },
    { name: 'deploy_keys_repository_index', columns: ['repository_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  // The key means nothing without the repository, so the database removes it
  // rather than the application remembering to.
  belongsTo: [{ model: 'Repository', onDelete: 'cascade' }],

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    title: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(100) },
      factory: faker => `${faker.word.adjective()} runner`,
    },

    key_type: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required().max(32) },
      factory: () => 'ssh-ed25519',
    },

    public_key: {
      order: 4,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string().required() },
      factory: () => 'ssh-ed25519 AAAA',
    },

    fingerprint: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().required().max(100) },
      factory: faker => `SHA256:${faker.string.alphanumeric(43)}`,
    },

    /**
     * Whether this key may push.
     *
     * Off unless somebody turned it on, and stored rather than derived: a
     * capability that is computed from something else is a capability that
     * changes when that something else does, and nobody reads the release notes
     * of their own permissions.
     */
    can_write: {
      order: 6,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /**
     * When it was last used to reach the repository.
     *
     * The only way to tell a key that is doing a job from one that was added
     * for a machine that no longer exists.
     */
    last_used_at: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },
  },
})
