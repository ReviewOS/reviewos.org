import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** A direct grant on one repository, outside any team or organization role. */
export default defineModel({
  name: 'RepoCollaborator',
  table: 'repo_collaborators',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'repo_collaborators_repo_user_index', columns: ['repository_id', 'user_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 10 },
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

    permission: {
      order: 3,
      fillable: true,
      default: 'read',
      validation: { rule: schema.enum(['read', 'triage', 'write', 'maintain', 'admin']) },
      factory: faker => faker.helpers.arrayElement(['read', 'triage', 'write', 'maintain', 'admin']),
    },
  },
} as const)
