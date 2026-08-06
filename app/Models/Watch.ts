import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * How much somebody wants to hear about a repository.
 *
 * `participating` is the default people actually want: tell me about threads I
 * am in, not about every issue opened.
 */
export default defineModel({
  name: 'Watch',
  table: 'watches',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // One answer per person per repository. Two rows would mean the product
    // holds two opinions about how much somebody wants to hear from it.
    { name: 'watches_repo_user_index', columns: ['repository_id', 'user_id'], unique: true },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 15 },
  },

  belongsTo: [{ model: 'Repository', onDelete: 'cascade' }, 'User'],

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    user_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    subscription: {
      order: 3,
      fillable: true,
      default: 'participating',
      validation: { rule: schema.enum(['all', 'participating', 'ignore']) },
      factory: faker => faker.helpers.arrayElement(['all', 'participating', 'ignore']),
    },
  },
} as const)
