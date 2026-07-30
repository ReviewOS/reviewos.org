import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** Somebody starred a repository. */
export default defineModel({
  name: 'Star',
  table: 'stars',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'stars_repo_user_index', columns: ['repository_id', 'user_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 20 },
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
  },
} as const)
