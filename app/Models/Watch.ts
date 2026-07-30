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
    { name: 'watches_repo_user_index', columns: ['repository_id', 'user_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 15 },
  },

  belongsTo: ['Repository', 'User'],

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: faker => faker.number.int({ min: 1, max: 8 }),
    },

    user_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: faker => faker.number.int({ min: 1, max: 10 }),
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
