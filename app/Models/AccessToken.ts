import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A credential a machine authenticates with.
 *
 * There is one kind, and it is fine-grained: it names the repositories it can
 * reach and carries an explicit set of permissions, held as rows in
 * `AccessTokenPermission`. The reasoning is in `app/TokenScopes.ts`, and the
 * short version is that a permission list with a hole in it pushes people onto
 * a credential that carries everything.
 *
 * The secret is stored as a hash. `prefix` is kept in cleartext so a token found
 * in a log is identifiable and revocable without anybody having to guess which
 * one it is, and so a lookup can be an indexed read rather than a scan that
 * hashes every row.
 *
 * A grant here is an upper bound, never a widening. The effective permission is
 * this intersected with what the user themselves can do, recomputed per request,
 * so losing access to a repository revokes the token's reach into it with no
 * separate step.
 */
export default defineModel({
  name: 'AccessToken',
  table: 'access_tokens',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'access_tokens_prefix_index', columns: ['prefix'] },
    { name: 'access_tokens_user_index', columns: ['user_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 10 },
  },

  belongsTo: ['User'],
  hasMany: ['AccessTokenPermission'],

  attributes: {
    user_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** What it is for, in the owner's words. Shown in every list of tokens. */
    name: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(100) },
      factory: faker => `${faker.hacker.noun()} deploy`,
    },

    /**
     * The public half, in cleartext: `ros_` plus a short random id.
     *
     * Unique, because it is what a lookup keys on.
     */
    prefix: {
      order: 3,
      fillable: true,
      unique: true,
      validation: { rule: schema.string().required().max(32) },
      factory: faker => `ros_${faker.string.alphanumeric(12)}`,
    },

    /** SHA-256 of the whole token. The token itself is shown once and not kept. */
    token_hash: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().required().max(64) },
      factory: faker => faker.string.hexadecimal({ length: 64, prefix: '' }),
    },

    /**
     * Which repositories this token can reach: every one the user can, every one
     * in a named organization, or a chosen list held in
     * `access_token_repositories`.
     */
    selection: {
      order: 5,
      fillable: true,
      default: 'selected',
      validation: { rule: schema.enum(['all', 'organization', 'selected']) },
      factory: () => 'selected',
    },

    /** Set when the selection is `organization`. */
    organization_id: {
      order: 6,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /**
     * Required. There is no unlimited option, deliberately, which is why the
     * roadmap pairs this with warning somebody before it happens: an expiry
     * people are ambushed by is one they find a way to avoid setting.
     */
    expires_at: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().required() },
      factory: () => new Date(Date.now() + 90 * 24 * 3_600_000).toISOString(),
    },

    /** So an unused token is visible as unused. */
    last_used_at: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },

    last_used_ip: {
      order: 9,
      fillable: true,
      validation: { rule: schema.string().max(45) },
      factory: () => null,
    },

    revoked_at: {
      order: 10,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },

    /** Who revoked it. An organization owner may revoke a token that is not theirs. */
    revoked_by_id: {
      order: 11,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
} as const)
