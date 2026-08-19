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
    { name: 'workflow_steps_repository_index', columns: ['repository_id'] },
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

    /**
     * What the step runs, for a job that was **generated** rather than written.
     *
     * A job uploaded by another job has no definition rows: it was not in any
     * workflow file, so `workflow_version_steps` has nothing for it. These
     * columns are where its commands live, and the claim reads them for exactly
     * those jobs.
     *
     * Null for an ordinary job, whose steps come from the version - copying
     * them here as well would be two records of one thing, and the one that
     * drifts is always the copy.
     */
    command: {
      order: 20,
      fillable: true,
      validation: { rule: schema.string().max(65_535) },
      factory: () => null,
    },

    /** An action reference, for a generated step that uses one. */
    uses: {
      order: 21,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    /** `with:`, as JSON. */
    inputs: {
      order: 22,
      fillable: true,
      validation: { rule: schema.string().max(65_535) },
      factory: () => null,
    },

    /** `env:`, as JSON. */
    env: {
      order: 23,
      fillable: true,
      validation: { rule: schema.string().max(65_535) },
      factory: () => null,
    },

    working_directory: {
      order: 24,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    shell: {
      order: 25,
      fillable: true,
      validation: { rule: schema.string().max(100) },
      factory: () => null,
    },

    /** `if:`, evaluated by the runner because it reads what earlier steps left. */
    condition: {
      order: 26,
      fillable: true,
      validation: { rule: schema.string().max(2000) },
      factory: () => null,
    },

    /** `id:`, which `steps.<id>.outputs` is keyed on. */
    step_id: {
      order: 27,
      fillable: true,
      validation: { rule: schema.string().max(100) },
      factory: () => null,
    },

    continue_on_error: {
      order: 28,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    timeout_minutes: {
      order: 29,
      fillable: true,
      validation: { rule: schema.number() },
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

    /**
     * The repository this belongs to, copied from its job.
     *
     * Denormalized, and the duplication is the point: this is the column a
     * sharded keyspace routes on, and Vitess cannot follow a foreign key to
     * find it - least of all through two of them, which is the shape here. A
     * grandchild left without it lands in the unsharded keyspace, and every
     * transaction touching it and its parent crosses keyspaces.
     *
     * Written where the row is created, from the parent already in hand.
     * `buddy db:keyspaces --check` is what notices when it is not.
     */
    repository_id: {
      order: 90,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
})
