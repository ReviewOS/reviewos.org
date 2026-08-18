import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One attempt to carry out a workflow version.
 *
 * The database is the source of truth for orchestration, not the runner. A
 * runner may accept work and disappear - the machine is somebody else's, by the
 * decision in [the threat model](../../docs/ci-threat-model.md) - and the run
 * has to remain inspectable and resumable without trusting anything it
 * remembered.
 *
 * **The trigger is recorded, not inferred.** Which event started a run, which
 * ref it was on, and which revision supplied the *workflow* are three different
 * facts, and the third is the one the fork policy turns on: a pull request from
 * a fork runs the base branch's definition, so the run has to say so rather
 * than let a reader assume the commit it tested is the commit it trusted.
 */
export default defineModel({
  name: 'WorkflowRun',
  table: 'workflow_runs',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // The repository's run list, newest first.
    { name: 'workflow_runs_repository_index', columns: ['repository_id', 'id'] },
    // The scheduler's question: what is not finished.
    { name: 'workflow_runs_state_index', columns: ['state', 'id'] },
    /**
     * What makes a redelivered webhook harmless.
     *
     * A push that is delivered twice produces the same version, ref and commit,
     * so the second insert collides here and no second run exists. Enforced by
     * the database rather than by a check-then-insert, because two deliveries
     * arriving together would both pass the check.
     */
    /*
     * Partial, and what it excludes is the point.
     *
     * This guards against a *redelivered* event: the same push arriving twice
     * must not make two runs. A manual `workflow_dispatch` and a `schedule`
     * are not deliveries - nothing arrived - and both repeat at the same ref
     * and the same commit by design. A nightly job would otherwise run once,
     * ever, and pressing "run workflow" a second time would be refused.
     *
     * What stops a schedule double-firing is not this index but the
     * compare-and-swap on `workflows.last_scheduled_at`.
     */
    { name: 'workflow_runs_redelivery_index', columns: ['workflow_version_id', 'event_ref', 'head_sha', 'event'], unique: true, where: 'event NOT IN (\'workflow_dispatch\', \'schedule\')' },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  belongsTo: [
    { model: 'WorkflowVersion', onDelete: 'cascade' },
    { model: 'Repository', onDelete: 'cascade' },
  ],

  attributes: {
    workflow_version_id: {
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

    /** Ascending per repository, so a person can say "run 42". */
    number: {
      order: 3,
      fillable: true,
      default: 1,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    /**
     * Explicit states, with terminal ones that cannot move backwards.
     *
     * `cancelling` is separate from `cancelled` because cancellation is
     * cooperative first: the run has been told to stop and has not finished
     * stopping, and a screen that showed those as the same thing would claim
     * work had ended while it was still running.
     */
    state: {
      order: 4,
      fillable: true,
      default: 'queued',
      validation: {
        rule: schema.enum([
          'queued', 'running', 'waiting', 'paused',
          'cancelling', 'cancelled', 'failed', 'succeeded',
        ]),
      },
      factory: () => 'queued',
    },

    /** `push`, `pull_request`, `pull_request_target`, `schedule`, `dispatch`. */
    event: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().required().max(40) },
      factory: () => 'push',
    },

    /** The ref the event was about: `refs/heads/main`. */
    event_ref: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(400) },
      factory: () => 'refs/heads/main',
    },

    /** The commit the run is *about*. */
    head_sha: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    /**
     * The commit the *definition* came from.
     *
     * Equal to `head_sha` for an ordinary push and deliberately not for a fork
     * pull request, where the workflow is the base branch's. Storing both is
     * what lets the interface say which is which instead of implying they are
     * the same commit.
     */
    definition_sha: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    /**
     * Whether this run is allowed secrets.
     *
     * Written at creation from the fork policy, not decided later by whatever
     * asks. A run from an unapproved fork is untrusted for its whole life, and
     * a column read at injection time is one place to look rather than a rule
     * every caller re-derives.
     */
    /**
     * The concurrency group this run belongs to, resolved.
     *
     * Stored on the run rather than derived, because it is resolved against
     * *this* event - the ref, the workflow, the event name - and a reader
     * asking "why was this cancelled" needs the value that was actually
     * compared, not one recomputed later from a definition that may have moved.
     */
    concurrency_group: {
      order: 40,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    /**
     * The inputs a `workflow_dispatch` run was started with, as JSON.
     *
     * The values that were *used*, with defaults filled in - not what somebody
     * typed. A person reading a run later needs to know what it ran with, and
     * "the default applied" is exactly the fact that is otherwise invisible.
     */
    /**
     * How many triggers deep this run is.
     *
     * A workflow that triggers a workflow that triggers the first one is a run
     * factory, and nothing else in the model stops it: every trigger makes a
     * *new* run, so there is no row to notice the loop. The depth is carried
     * down and refused past a ceiling, which bounds it with one integer rather
     * than with a cycle check over definitions that can change between runs.
     */
    trigger_depth: {
      order: 42,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    /**
     * How many times a job in this run has uploaded steps.
     *
     * The budget lives on the run rather than per job, because the thing worth
     * bounding is what the *run* can grow into: ten jobs uploading twice each
     * is the same twenty uploads as one job uploading twenty times.
     */
    uploads: {
      order: 43,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    dispatch_inputs: {
      order: 41,
      fillable: true,
      validation: { rule: schema.string().max(16_000) },
      factory: () => null,
    },

    /**
     * Whether a person has to say yes before this run starts.
     *
     * The fork policy's last clause. A pull request from a fork is somebody
     * else's code on machines an operator provided: it gets no secrets and no
     * identity token and cannot supply its own workflow, and it still spends the
     * fleet and still reaches whatever those machines reach.
     *
     * `not-required` for every run that is the repository's own, which is nearly
     * all of them. `required` holds the run in `waiting` until somebody with
     * `workflow:approve` opens it; `rejected` is a run somebody decided should
     * not have run, kept rather than deleted so the decision is on the record.
     */
    approval_state: {
      order: 70,
      fillable: true,
      default: 'not-required',
      validation: { rule: schema.enum(['not-required', 'required', 'approved', 'rejected']) },
      factory: () => 'not-required',
    },

    /** Who opened it, for a run that needed opening. */
    approved_by: {
      order: 71,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    approved_at: {
      order: 72,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    trusted: {
      order: 9,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /** Who or what started it. Null for an event with no person behind it. */
    actor_id: {
      order: 10,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** The pull request this run is about, when there is one. */
    pull_request_id: {
      order: 11,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /**
     * Which attempt of this run is current.
     *
     * A re-run does not make a second run: the commit, the workflow version and
     * the number are the same, and a reader comparing two rows would have no
     * way to tell which was the answer. It makes a second *attempt*, which is
     * what `GITHUB_RUN_ATTEMPT` means and what every action that names its
     * cache after it expects.
     */
    attempt: {
      order: 12,
      fillable: true,
      default: 1,
      validation: { rule: schema.number() },
      factory: () => 1,
    },

    started_at: {
      order: 12,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    finished_at: {
      order: 13,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    /** Why it ended as it did, for a reader rather than for a machine. */
    conclusion_reason: {
      order: 14,
      fillable: true,
      validation: { rule: schema.string().max(1000) },
      factory: () => null,
    },
  },
})
