import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One job of a run: a unit of work handed to one runner.
 *
 * The run-side counterpart of `WorkflowVersionJob`, which is the definition.
 * They are separate tables under different names because a run has to stay
 * readable after the definition has moved on - collapsing them is how a
 * finished run starts showing jobs it never executed.
 *
 * **The lease is what makes a disconnected runner safe.** A job is handed out
 * with an expiry, and results are accepted only from the holder and only before
 * it lapses. Without that, a worker that lost its connection can come back and
 * publish a success over a run that was cancelled, which is the one outcome a
 * branch protection rule must never be told.
 */
export default defineModel({
  name: 'WorkflowJob',
  table: 'workflow_jobs',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'workflow_jobs_run_index', columns: ['workflow_run_id', 'position'] },
    // The dispatcher's question: what is ready to hand out.
    { name: 'workflow_jobs_state_index', columns: ['state', 'id'] },
    { name: 'workflow_jobs_lease_index', columns: ['lease_expires_at'] },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  belongsTo: [{ model: 'WorkflowRun', onDelete: 'cascade' }],

  attributes: {
    workflow_run_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** The definition's key, so a job can be found across runs by name. */
    job_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(100) },
      factory: () => 'test',
    },

    name: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().max(200) },
      factory: () => null,
    },

    position: {
      order: 4,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    /**
     * `blocked` is a state, not an absence.
     *
     * A job waiting on `needs:` is not queued - nothing should hand it out -
     * and it is not skipped either. Modelling it as "queued but ignored" is how
     * a dispatcher ends up encoding the dependency graph in queue timing, which
     * the roadmap asks it not to.
     */
    state: {
      order: 5,
      fillable: true,
      default: 'blocked',
      validation: {
        rule: schema.enum([
          'blocked', 'queued', 'running', 'cancelling',
          'cancelled', 'failed', 'skipped', 'succeeded',
        ]),
      },
      factory: () => 'blocked',
    },

    /** Job ids this waits on, copied from the definition. */
    needs: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(1000) },
      factory: () => null,
    },

    runs_on: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => 'ubuntu-latest',
    },

    /** Which runner holds it. Null until one takes it. */
    runner_id: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string().max(200) },
      factory: () => null,
    },

    /** When the lease lapses, after which nothing this runner says counts. */
    lease_expires_at: {
      order: 9,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    started_at: {
      order: 10,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    finished_at: {
      order: 11,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },
  },
})
