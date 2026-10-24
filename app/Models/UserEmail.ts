import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** Additional addresses belong to one account, never to a second identity. */
export default defineModel({
  name: 'UserEmail',
  table: 'user_emails',
  primaryKey: 'id',
  autoIncrement: true,
  traits: { useTimestamps: true },
  belongsTo: [{ model: 'User', foreignKey: 'user_id', onDelete: 'cascade' }],
  indexes: [{ name: 'user_emails_user_index', columns: ['user_id'] }],
  attributes: {
    user_id: {
      fillable: true,
      required: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },
    email: {
      fillable: true,
      required: true,
      unique: true,
      validation: { rule: schema.string().email().required().max(255) },
      factory: faker => faker.internet.email().toLowerCase(),
    },
    verified_at: {
      fillable: false,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },
  },
} as const)
