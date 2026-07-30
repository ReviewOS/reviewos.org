import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A public key a user pushes with.
 *
 * The fingerprint is unique across every user, not per user: a key identifies
 * whoever holds the private half, so the same key registered twice would make
 * authorship ambiguous.
 */
export default defineModel({
  name: 'SshKey',
  table: 'ssh_keys',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'ssh_keys_fingerprint_index', columns: ['fingerprint'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 6 },
  },

  belongsTo: ['User'],

  attributes: {
    user_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    title: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(100) },
      factory: faker => `${faker.word.adjective()} laptop`,
    },

    key_type: {
      order: 3,
      fillable: true,
      validation: { rule: schema.enum(['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256']) },
      factory: () => 'ssh-ed25519',
    },

    public_key: {
      order: 4,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string().required() },
      factory: faker => `ssh-ed25519 ${faker.string.alphanumeric(68)}`,
    },

    fingerprint: {
      order: 5,
      unique: true,
      fillable: true,
      validation: { rule: schema.string().required().max(100) },
      factory: faker => `SHA256:${faker.string.alphanumeric(43)}`,
    },

    last_used_at: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string() },
      factory: faker => faker.date.recent().toISOString(),
    },
  },
} as const)
