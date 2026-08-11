import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One step of a job in a run.
 *
 * Persisted before the next step becomes eligible, which is what durable
 * execution means here: the control plane can be restarted between any two
 * steps and pick up from the rows rather than from whatever the runner had in
 * memory. A step that ran and was not recorded is a step that runs twice.
 */
export default defineModel({
  name: 'WorkflowStep',
  table: 'workflow_steps',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'workflow_steps_job_index', columns: ['workflow_job_id', 'position'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  belongsTo: [{ model: 'WorkflowJob', onDelete: 'cascade' }],

  attributes: {
    workflow_job_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    position: {
      order: 2,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    name: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().max(200) },
      factory: () => null,
    },

    state: {
      order: 4,
      fillable: true,
      default: 'pending',
      validation: {
        rule: schema.enum(['pending', 'running', 'cancelled', 'failed', 'skipped', 'succeeded']),
      },
      factory: () => 'pending',
    },

    /**
     * How many times this step has been attempted.
     *
     * On the step as well as in `WorkflowStepAttempt` rows, because "did this
     * retry" is asked on every render of a run and counting rows to answer it
     * is a query per step.
     */
    attempts: {
      order: 5,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    /** The exit status of the last attempt, when there was one. */
    exit_code: {
      order: 6,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    started_at: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    finished_at: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },
  },
})
