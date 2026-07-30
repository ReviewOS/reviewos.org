import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A public key used to verify commit signatures.
 *
 * Registered here in phase 1; the verification that reads it lands with commit
 * browsing in phase 2, so a key added now starts being useful then.
 */
export default defineModel({
  name: 'GpgKey',
  table: 'gpg_keys',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'gpg_keys_key_id_index', columns: ['key_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 4 },
  },

  belongsTo: ['User'],

  attributes: {
    user_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    key_id: {
      order: 2,
      unique: true,
      fillable: true,
      validation: { rule: schema.string().required().max(64) },
      factory: faker => faker.string.hexadecimal({ length: 16, prefix: '' }).toUpperCase(),
    },

    public_key: {
      order: 3,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string().required() },
      factory: () => '-----BEGIN PGP PUBLIC KEY BLOCK-----',
    },

    emails: {
      order: 4,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: faker => JSON.stringify([faker.internet.email().toLowerCase()]),
    },

    expires_at: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string() },
      factory: faker => faker.date.future().toISOString(),
    },
  },
} as const)
