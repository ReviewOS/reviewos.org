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
     * What this step produced, as a value.
     *
     * The `inputs` column above has always held what a step was *asked* to do;
     * this is what it answered. Both being rows is what makes restart-from-step
     * mean something: a step can only be skipped on a restart if its result was
     * recorded as a value, and a result that lives only in a log is one that has
     * to be scraped back out of text somebody's script wrote.
     *
     * Redacted and capped where it is written, like a job's outputs, for the
     * same reason: an output is read by whatever comes after it, so a secret
     * that lands here has left the step it was scoped to.
     */
    outputs: {
      order: 9,
      fillable: true,
      validation: { rule: schema.string().max(20_000) },
      factory: () => null,
    },

    /**
     * Why this step failed, when it did.
     *
     * Beside the exit status rather than instead of it: a number says a command
     * refused and a sentence says which command and what it was reaching for,
     * and a screen with only the first sends somebody into a log to find the
     * second. Bounded and untrusted, like everything a runner says - the log
     * lives elsewhere behind its own limits, and this is the one line a run
     * screen can show without opening it.
     */
    error: {
      order: 13,
      fillable: true,
      validation: { rule: schema.string().max(2000) },
      factory: () => null,
    },

    /**
     * The job attempt that actually produced this result, when it was not this one.
     *
     * Set by a restart-from-step on every step whose recorded result it kept,
     * and null on a step this attempt ran itself. Without it, a run screen shows
     * a green step beside a red one from the same attempt and cannot say that
     * the green one is nine minutes of work nothing repeated - which is the
     * fact somebody restarting from a step wants confirmed.
     *
     * A number rather than a row id: it is what the log endpoint filters on, so
     * the interface can link the kept result to the attempt whose output
     * explains it.
     */
    reused_from_attempt: {
      order: 12,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /**
     * How long this step waited before anything ran it, in milliseconds.
     *
     * Separate from the time it spent working, and the separation is the whole
     * point: **a step that took nine minutes of which eight were queueing is a
     * different problem from one that took nine minutes of work.** One number
     * cannot say which, and the two have different fixes - more machines, or a
     * faster step.
     */
    queued_ms: {
      order: 10,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /**
     * How long this step was actually executing, in milliseconds.
     *
     * Wall time is `finished_at` minus `started_at` and is derived rather than
     * stored, because a stored copy of a subtraction is a third number that can
     * disagree with the two it came from. What cannot be derived is this: a step
     * that spent four of its five minutes waiting on a service is not a step
     * that worked for five minutes, and only the runner knows the difference.
     */
    active_ms: {
      order: 11,
      fillable: true,
      validation: { rule: schema.number() },
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
