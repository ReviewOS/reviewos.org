import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One person's own credential for an upstream forge.
 *
 * Write-through review needs a token, and *whose* token it is decides whether
 * the feature is worth having. A review posted upstream by a shared account
 * says "reviewos-bot approved this" over the top of somebody's actual judgement,
 * and the person who wrote it is reduced to a line of quoted text inside a
 * comment written by a machine. Attribution is the product here: the phase 13
 * rule is that a review must be attributable to the person who wrote it, so
 * this table is per-user and there is deliberately no instance-wide fallback.
 *
 * The token is encrypted at rest with the same seam workflow secrets use, so a
 * database dump is a list of who has connected an account rather than a list of
 * credentials. `scopes` and `remote_login` are stored in the clear because they
 * are what the interface has to show ("connected as @chris, can write reviews")
 * and neither is worth anything on its own.
 *
 * Deliberately *not* a copy of the sign-in identity. `users.github_username`
 * says who somebody is on GitHub; this says they handed this instance a
 * credential to act as them, which is a separate decision, separately revocable,
 * and one they can take back without losing their account here.
 */
export default defineModel({
  name: 'ForgeCredential',
  table: 'forge_credentials',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // The lookup every write-through does: this person, this forge, this host.
    { name: 'forge_credentials_owner_index', columns: ['user_id', 'provider', 'host'], unique: true },
  ],

  traits: {
    useTimestamps: true,
    useUuid: true,
  },

  attributes: {
    user_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    provider: {
      order: 2,
      fillable: true,
      default: 'github',
      validation: { rule: schema.enum(['github', 'gitlab', 'gitea']) },
      factory: () => 'github',
    },

    /**
     * Which instance of that forge, so an enterprise host is a separate grant.
     *
     * `github.com` for the public one. Without it, a credential for a company's
     * own GitHub Enterprise would be tried against github.com the first time
     * somebody mirrored a public repository, and a token sent to the wrong host
     * is a token disclosed to it.
     */
    host: {
      order: 3,
      fillable: true,
      default: 'github.com',
      validation: { rule: schema.string().required().max(255) },
      factory: () => 'github.com',
    },

    /** Who this credential acts as upstream, for the interface to show. */
    remote_login: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(120) },
      factory: () => null,
    },

    /** The encrypted token. Never selected into anything a request renders. */
    sealed: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().required().max(4000) },
      factory: () => 'sealed',
    },

    /**
     * What the token says it can do, as the forge reported it at connect time.
     *
     * Checked before a write is attempted so the failure is "this credential
     * cannot write reviews, reconnect with the scope" rather than a 403 from
     * somebody else's API quoted back at a person who cannot act on it.
     */
    scopes: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    last_used_at: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    /** Why it stopped working, when it did. Cleared on the next success. */
    last_error: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },
  },
})
