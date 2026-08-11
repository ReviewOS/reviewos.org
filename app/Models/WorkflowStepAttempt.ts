import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One try at one step.
 *
 * A row per attempt rather than a counter, because a retry that succeeded after
 * failing twice is a different fact from a step that succeeded, and a counter
 * cannot tell them apart. Flakiness is measured from these - which is where
 * phase 15's test intelligence starts - and a step that overwrote its own
 * history has nothing to measure.
 *
 * **Everything a runner reports is untrusted input.** The runner is somebody
 * else's machine executing hostile code by design, so an error message is text
 * of arbitrary length and content, and the log lives elsewhere behind its own
 * limits rather than in a column here.
 */
export default defineModel({
  name: 'WorkflowStepAttempt',
  table: 'workflow_step_attempts',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'workflow_step_attempts_step_index', columns: ['workflow_step_id', 'attempt'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  belongsTo: [{ model: 'WorkflowStep', onDelete: 'cascade' }],

  attributes: {
    workflow_step_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** 1 for the first try, so "attempt 3" reads as a person would say it. */
    attempt: {
      order: 2,
      fillable: true,
      default: 1,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    state: {
      order: 3,
      fillable: true,
      default: 'running',
      validation: { rule: schema.enum(['running', 'cancelled', 'failed', 'succeeded']) },
      factory: () => 'running',
    },

    exit_code: {
      order: 4,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** Which runner ran this try, so a run records what executed it. */
    runner_id: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(200) },
      factory: () => null,
    },

    /** Truncated on the way in: a runner can send as much as it likes. */
    error: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(4000) },
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
