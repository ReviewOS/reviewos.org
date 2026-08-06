import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One repository a token was scoped to.
 *
 * The join table behind `selection: 'selected'`. A list of ids in a text column
 * would have been fewer files and no migration, and it would also have made
 * "revoke every token that can reach this repository" a scan with string
 * matching on a value that has no referential integrity.
 */
export default defineModel({
  name: 'AccessTokenRepository',
  table: 'access_token_repositories',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'access_token_repositories_token_index', columns: ['access_token_id'] },
    { name: 'access_token_repositories_repository_index', columns: ['repository_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 20 },
  },

  belongsTo: ['AccessToken', { model: 'Repository', onDelete: 'cascade' }],

  attributes: {
    access_token_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    repository_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },
  },
} as const)
