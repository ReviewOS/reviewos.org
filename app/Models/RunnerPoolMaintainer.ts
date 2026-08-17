import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Somebody who may manage one pool without administering the instance.
 *
 * The role exists because the alternative is what every self-hosted forge ends
 * up with: the person who looks after the build machines is made an instance
 * administrator, because draining a queue needs it - and now they can read
 * every private repository on the instance. A pool maintainer can create
 * queues, mint and revoke registration tokens, drain, and stop machines, in
 * *their* pool, and nothing else.
 *
 * Deliberately per pool rather than a global "fleet operator": a fleet with two
 * pools usually has them because two groups own different machines, and a role
 * that spans both would put each group's credentials within reach of the other.
 */
export default defineModel({
  name: 'RunnerPoolMaintainer',
  table: 'runner_pool_maintainers',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'runner_pool_maintainers_pool_index', columns: ['runner_pool_id'] },
    { name: 'runner_pool_maintainers_user_index', columns: ['user_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  belongsTo: [{ model: 'RunnerPool', onDelete: 'cascade' }, { model: 'User', onDelete: 'cascade' }],

  attributes: {
    runner_pool_id: {
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
