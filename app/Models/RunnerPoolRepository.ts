import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One repository a pool serves.
 *
 * The join table behind "a pool with no repositories listed is unrestricted".
 * A list of ids in a text column would have been fewer files and would also
 * have made "which pools can reach this repository" a scan with string
 * matching on a value with no referential integrity - and that question is
 * asked when somebody is working out how a secret got onto a machine.
 */
export default defineModel({
  name: 'RunnerPoolRepository',
  table: 'runner_pool_repositories',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'runner_pool_repositories_pool_index', columns: ['runner_pool_id'] },
    { name: 'runner_pool_repositories_repository_index', columns: ['repository_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  belongsTo: [{ model: 'RunnerPool', onDelete: 'cascade' }, { model: 'Repository', onDelete: 'cascade' }],

  attributes: {
    runner_pool_id: {
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
