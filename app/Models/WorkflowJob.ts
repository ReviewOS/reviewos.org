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
          /*
           * `paused` is a gate waiting for a person.
           *
           * Not `blocked`, which means "waiting for another job" and is
           * something the graph will resolve on its own: nothing resolves this
           * one but somebody deciding, and a run screen that cannot tell the
           * two apart cannot show the button.
           */
          'paused',
        ]),
      },
      factory: () => 'blocked',
    },

    /** `if:` as written, copied from the definition so the run stays readable. */
    condition: {
      order: 32,
      fillable: true,
      validation: { rule: schema.string().max(2000) },
      factory: () => null,
    },

    /**
     * Why the condition decided what it did, in words.
     *
     * A skipped job is the one outcome with nothing to look at - no logs, no
     * steps, no runner - so the reason has to be written down at the moment it
     * is decided or it is gone.
     */
    condition_reason: {
      order: 33,
      fillable: true,
      validation: { rule: schema.string().max(1000) },
      factory: () => null,
    },

    /** Job ids this waits on, copied from the definition. */
    /**
     * The matrix values this job was created for, as JSON.
     *
     * One `workflow_jobs` row per combination, so a matrix of four is four jobs
     * in the run rather than one job that somehow ran four times. Null for a
     * job with no matrix.
     *
     * Stored on the job rather than derived from the version at read time: the
     * run has to stay readable when the definition changes, which is the same
     * reason the steps are copied.
     */
    matrix_values: {
      order: 30,
      fillable: true,
      validation: { rule: schema.string().max(4000) },
      factory: () => null,
    },

    /**
     * The concurrency group this job belongs to, resolved against its run.
     *
     * On the job rather than derived, for the same reason the run carries its
     * own: somebody asking why a job was cancelled needs the value that was
     * compared, not one recomputed from a definition that has since moved.
     */
    concurrency_group: {
      order: 31,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    /**
     * What this job produced, as JSON.
     *
     * Reported by the runner when the job finishes, and read by the jobs that
     * `needs:` it. On the run's job rather than on the definition, because an
     * output is a fact about one run: two runs of the same workflow produce
     * different values, and a column shared with the definition could only hold
     * the last one.
     */
    outputs: {
      order: 34,
      fillable: true,
      validation: { rule: schema.string().max(65_535) },
      factory: () => null,
    },

    /*
     * The four policy columns below are copied from the definition onto the
     * run, like `needs` and `condition` above them.
     *
     * They decide what a *finished* run means - whether a failure failed it,
     * whether its siblings were stopped, how long it was allowed - and reading
     * them back from a definition that has since changed would make a run's
     * conclusion something nobody can reconstruct. A run has to stay readable
     * after the file moved on.
     */

    /**
     * What kind of job this is, copied from the definition.
     *
     * `command` is the only kind a runner may claim. The others are the
     * control plane's own work - a barrier its dependencies satisfy, a gate a
     * person opens, a trigger that starts another run - and handing one to a
     * machine would mean a runner deciding a deployment approval.
     */
    kind: {
      order: 39,
      fillable: true,
      default: 'command',
      validation: { rule: schema.enum(['command', 'wait', 'block', 'trigger']) },
      factory: () => 'command',
    },

    /** The kind's configuration, copied so a finished run stays readable. */
    settings: {
      order: 40,
      fillable: true,
      validation: { rule: schema.string().max(20_000) },
      factory: () => null,
    },

    /** The label this job shares with the others in its group. */
    group_label: {
      order: 41,
      fillable: true,
      validation: { rule: schema.string().max(200) },
      factory: () => null,
    },

    /**
     * Who opened this gate, and when.
     *
     * On the job rather than only in the audit log: "who approved this
     * deployment" is a question asked while looking at the run, and an answer
     * that lives somewhere else is one nobody finds.
     */
    approved_by_id: {
      order: 42,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    approved_at: {
      order: 43,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    /**
     * Which attempt this is, counting from one.
     *
     * On the job rather than derived from a count of anything: a retry is the
     * *same* job running again, and a screen that says "attempt 3" is saying
     * something about this row rather than about three rows somebody has to
     * find. It also bounds the lease sweep - a job whose runner keeps dying
     * used to be requeued forever, because nothing counted.
     */
    attempt: {
      order: 45,
      fillable: true,
      default: 1,
      validation: { rule: schema.number() },
      factory: () => 1,
    },

    /**
     * The run a `trigger` job started.
     *
     * Both a link for the screen and the thread `await: true` is closed by:
     * the job waiting is in another run entirely, so when the triggered run
     * finishes there is nothing else that would ever look at it again.
     */
    triggered_run_id: {
      order: 44,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** `strategy.fail-fast`: one combination failing stops the rest. */
    fail_fast: {
      order: 35,
      fillable: true,
      default: true,
      validation: { rule: schema.boolean() },
      factory: () => true,
    },

    /** `strategy.max-parallel`: how many combinations may run at once. */
    max_parallel: {
      order: 36,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** `timeout-minutes:`, after which the job is stopped rather than waited on. */
    timeout_minutes: {
      order: 37,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** `continue-on-error:`: this job may fail without failing the run. */
    continue_on_error: {
      order: 38,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

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

    /**
     * SHA-256 of the credential minted for this claim.
     *
     * The registration token says "I am that machine" and is the one an
     * operator installs once and never rotates. Using it to report results
     * means the credential with the longest life and the widest reach is the
     * one travelling on every call - and by [the threat
     * model](../../docs/ci-threat-model.md) it must never reach a job
     * environment at all.
     *
     * So a claim mints a token that is good for one job, expires with the
     * lease, and is cleared when the job ends. A leaked one buys the attacker
     * the job they already had, for as long as it was going to run.
     *
     * Hashed for the same reason the registration token is: a credential in
     * the database in plain text is a credential in every backup.
     */
    job_token_hash: {
      order: 10,
      fillable: true,
      validation: { rule: schema.string().max(64) },
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
