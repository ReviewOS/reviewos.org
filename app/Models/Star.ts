import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** Somebody starred a repository. */
export default defineModel({
  name: 'Star',
  table: 'stars',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // One star per person per repository. Two rapid clicks would otherwise
    // leave two rows, and the star count would be permanently one too high.
    { name: 'stars_repo_user_index', columns: ['repository_id', 'user_id'], unique: true },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 20 },
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
  },
} as const)
