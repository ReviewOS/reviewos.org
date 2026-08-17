import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Where jobs wait for a particular kind of machine.
 *
 * Named for infrastructure rather than for teams - `linux-x64-large`, not
 * `payments` - because a queue is a description of what a machine *is*, and a
 * queue named after a team is one that has to be renamed when the team does.
 *
 * **Pausing is the point of the row.** Draining a queue is the ordinary way to
 * take machines out of service: stop handing it work, let what is running
 * finish, and the jobs already waiting stay waiting rather than failing. The
 * alternative operators reach for otherwise is deleting the runners, which
 * loses their identity and their history and cannot be undone at four in the
 * afternoon when the maintenance turns out not to be needed.
 *
 * A runner belongs to at most one queue. A runner in none behaves exactly as
 * every runner did before pools existed - matched by label and by scope - so an
 * instance that never opens this screen never notices it.
 */
export default defineModel({
  name: 'RunnerQueue',
  table: 'runner_queues',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'runner_queues_pool_index', columns: ['runner_pool_id', 'state'] },
    { name: 'runner_queues_name_index', columns: ['name'] },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  belongsTo: [{ model: 'RunnerPool', onDelete: 'cascade' }],

  attributes: {
    runner_pool_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** `linux-x64-large`. What the machines in it are, not who uses them. */
    name: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(100) },
      factory: () => 'default',
    },

    /**
     * `active` or `paused`.
     *
     * Paused means no claim from this queue succeeds. The jobs waiting on it
     * stay queued and say why, which is the difference between a drain and an
     * outage.
     */
    state: {
      order: 3,
      fillable: true,
      default: 'active',
      validation: { rule: schema.enum(['active', 'paused']) },
      factory: () => 'active',
    },

    /** Why it is paused, for the run page and for the operator who returns. */
    paused_reason: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },
  },
} as const)
