import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One job in a workflow's definition.
 *
 * The definition, not the run. `WorkflowJob` in the run models is a job that
 * happened; this is the row that says what one *would* be, and the two are kept
 * apart under different names because a run has to remain readable after the
 * definition has moved on. Collapsing them is how a completed run starts
 * showing steps it never executed.
 *
 * `needs` is stored as written rather than as edges between rows. The graph is
 * read whole, per run, and never queried across workflows - and the validator
 * has already refused a `needs` naming a job that does not exist, so a row-level
 * foreign key would be enforcing a rule that cannot be violated by the time
 * anything gets here.
 */
export default defineModel({
  name: 'WorkflowVersionJob',
  table: 'workflow_version_jobs',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'workflow_version_jobs_version_index', columns: ['workflow_version_id', 'position'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  belongsTo: [{ model: 'WorkflowVersion', onDelete: 'cascade' }],

  attributes: {
    workflow_version_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** The key in `jobs:`, which is what `needs:` refers to. */
    job_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(100) },
      factory: () => 'test',
    },

    /** Declaration order, so the interface lists them as the author wrote them. */
    position: {
      order: 3,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    name: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(200) },
      factory: () => null,
    },

    /** Runner labels, one per line. */
    runs_on: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => 'ubuntu-latest',
    },

    /** Job ids this waits on, one per line. */
    needs: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(1000) },
      factory: () => null,
    },

    /** The `if:` expression, stored unevaluated. Nothing here runs it. */
    condition: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().max(1000) },
      factory: () => null,
    },

    /**
     * The matrix, expanded at parse time, as JSON.
     *
     * Expanded here rather than at dispatch because the number of jobs a run
     * will carry is a fact about the file: a run screen that cannot say how
     * many jobs are coming until they arrive is a progress bar with no end.
     * Null for a job with no matrix, which is most of them.
     */
    matrix: {
      order: 30,
      fillable: true,
      validation: { rule: schema.string().max(65_535) },
      factory: () => null,
    },

    /**
     * Actions' default is true, and it is the surprising direction: one failed
     * combination cancels the rest. Stored per job because that is where the
     * workflow says it.
     */
    fail_fast: {
      order: 31,
      fillable: true,
      default: true,
      validation: { rule: schema.boolean() },
      factory: () => true,
    },

    max_parallel: {
      order: 32,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** `env:` on the job, as JSON. Overrides the workflow's. */
    env: {
      order: 33,
      fillable: true,
      validation: { rule: schema.string().max(16_000) },
      factory: () => null,
    },

    /** `permissions:` on the job. Replaces the workflow's rather than adding to it. */
    permissions: {
      order: 34,
      fillable: true,
      validation: { rule: schema.string().max(4000) },
      factory: () => null,
    },

    /**
     * `concurrency:` on the job, as written.
     *
     * A group of its own, resolved per run like the workflow's - a workflow
     * whose runs may overlap can still hold one deployment job to one at a
     * time.
     */
    concurrency_group: {
      order: 35,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    job_cancel_in_progress: {
      order: 36,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /** `defaults.run.shell` on the job, which overrides the workflow's. */
    default_shell: {
      order: 37,
      fillable: true,
      validation: { rule: schema.string().max(200) },
      factory: () => null,
    },

    default_working_directory: {
      order: 38,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    /**
     * `uses:` - this job is another workflow rather than a list of steps.
     *
     * Stored on the job because that is where it is written, and read at
     * dispatch, which is where the called workflow's jobs are copied into the
     * run.
     */
    uses: {
      order: 39,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    /** `with:` for the call, as JSON. */
    call_with: {
      order: 40,
      fillable: true,
      validation: { rule: schema.string().max(16_000) },
      factory: () => null,
    },

    /**
     * `secrets:` for the call: a mapping, or the word `inherit`.
     *
     * Kept as written. Expanding `inherit` at parse time would decide what a
     * run may read before the fork check has happened, and by the threat model
     * that decision belongs at injection.
     */
    call_secrets: {
      order: 41,
      fillable: true,
      validation: { rule: schema.string().max(8000) },
      factory: () => null,
    },

    /**
     * `outputs:` on the job, as JSON.
     *
     * Expressions over the job's own steps - `${{ steps.build.outputs.name }}` -
     * so they are stored as written and resolved by the runner once the steps
     * they read have actually run.
     */
    outputs: {
      order: 42,
      fillable: true,
      validation: { rule: schema.string().max(16_000) },
      factory: () => null,
    },

    timeout_minutes: {
      order: 8,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
})
