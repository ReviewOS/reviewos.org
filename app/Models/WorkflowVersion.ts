import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One commit's definition of a workflow, frozen.
 *
 * A run points here rather than at the `Workflow`, so a run from six months ago
 * still shows what actually ran. Nothing in this table is edited after it is
 * written: a change to the file makes a new version, and the old one stays
 * because runs reference it.
 *
 * **The digest is what makes that cheap.** A push that does not touch the
 * workflow file produces the same content digest, so the version is reused
 * rather than duplicated per commit - otherwise a repository with a daily push
 * accumulates a version a day, all identical, and "which versions of this
 * workflow have existed" stops being answerable.
 *
 * The triggers are stored as columns rather than as the parsed YAML, because
 * dispatch reads them on every push and a JSON blob would mean parsing every
 * workflow in the repository to find out whether any of them cared. The step
 * graph is normalized into `WorkflowVersionJob` and `WorkflowVersionStep` for
 * the same reason the roadmap gives: querying, authorization and migrations are
 * all harder against a workflow-sized blob.
 */
export default defineModel({
  name: 'WorkflowVersion',
  table: 'workflow_versions',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // The reuse check on every push: has this exact content been seen before.
    { name: 'workflow_versions_digest_index', columns: ['workflow_id', 'content_digest'], unique: true },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  belongsTo: [{ model: 'Workflow', onDelete: 'cascade' }],

  attributes: {
    workflow_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** The commit the definition was read from. */
    source_sha: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    /** Where in that commit, so an error can name a file. */
    source_path: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().max(400) },
      factory: () => '.github/workflows/ci.yml',
    },

    /** SHA-256 of the file's bytes. Identical content is one version. */
    content_digest: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().required().max(64) },
      factory: () => null,
    },

    /**
     * Which events start this, denormalized for dispatch.
     *
     * `pull_request_target` is deliberately its own column rather than folded
     * into `on_pull_request`. It is the same event with the opposite trust -
     * the workflow comes from the base branch and runs with the base
     * repository's secrets against a fork's code - and the fork policy needs to
     * tell them apart. Folding them would make the dangerous one invisible at
     * exactly the point where it is being decided.
     */
    on_push: {
      order: 5,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => true,
    },

    on_pull_request: {
      order: 6,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    on_pull_request_target: {
      order: 7,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    on_dispatch: {
      order: 8,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /** `workflow_call`: started by another workflow, never by an event. */
    reusable: {
      order: 9,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /**
     * The filters, as written.
     *
     * Newline-separated rather than related rows: they are read together with
     * the version, always, and never queried across workflows. A `branches`
     * table would be four joins to answer a question nobody asks.
     */
    push_branches: {
      order: 10,
      fillable: true,
      validation: { rule: schema.string().max(2000) },
      factory: () => null,
    },

    push_tags: {
      order: 11,
      fillable: true,
      validation: { rule: schema.string().max(2000) },
      factory: () => null,
    },

    push_paths: {
      order: 12,
      fillable: true,
      validation: { rule: schema.string().max(4000) },
      factory: () => null,
    },

    /**
     * The negative filters, stored apart from the positive ones.
     *
     * Actions refuses a workflow that sets `branches` and `branches-ignore`
     * together, so these are never both populated for one event - but they mean
     * opposite things, and one merged column could not say which way round the
     * author wrote it.
     */
    push_branches_ignore: {
      order: 30,
      fillable: true,
      validation: { rule: schema.string().max(2000) },
      factory: () => null,
    },

    push_tags_ignore: {
      order: 31,
      fillable: true,
      validation: { rule: schema.string().max(2000) },
      factory: () => null,
    },

    push_paths_ignore: {
      order: 32,
      fillable: true,
      validation: { rule: schema.string().max(4000) },
      factory: () => null,
    },

    /**
     * The activity types a pull request workflow runs on.
     *
     * Empty means Actions' default - opened, synchronize, reopened - rather
     * than "every type", which is the distinction that decides whether closing
     * a pull request starts a run.
     */
    pull_request_types: {
      order: 35,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    pull_request_branches_ignore: {
      order: 33,
      fillable: true,
      validation: { rule: schema.string().max(2000) },
      factory: () => null,
    },

    pull_request_paths_ignore: {
      order: 34,
      fillable: true,
      validation: { rule: schema.string().max(4000) },
      factory: () => null,
    },

    pull_request_branches: {
      order: 13,
      fillable: true,
      validation: { rule: schema.string().max(2000) },
      factory: () => null,
    },

    pull_request_paths: {
      order: 14,
      fillable: true,
      validation: { rule: schema.string().max(4000) },
      factory: () => null,
    },

    /**
     * `concurrency:`, as written, with its expressions unresolved.
     *
     * The group is a template - `${{ github.workflow }}-${{ github.ref }}` is
     * the common one - and it can only be resolved against a particular event,
     * so it is stored as text and resolved per run.
     */
    concurrency_group: {
      order: 36,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    /**
     * Actions' default is false: a second run queues behind the first rather
     * than replacing it. Turning it on is what makes a branch's pipeline stop
     * wasting runners on commits nobody is waiting for any more.
     */
    cancel_in_progress: {
      order: 37,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /**
     * `reviewos.intermediate:` - what happens to runs still waiting when a
     * newer one arrives.
     *
     * `run` is Actions' behaviour and the default; `cancel` is
     * `concurrency.cancel-in-progress` said in one word; `skip` is the third
     * thing neither offers - let the build that started finish, drop the ones
     * that have not.
     */
    intermediate: {
      order: 44,
      fillable: true,
      default: 'run',
      validation: { rule: schema.enum(['run', 'skip', 'cancel']) },
      factory: () => 'run',
    },

    /**
     * `workflow_dispatch.inputs`, as JSON, in the order written.
     *
     * JSON because an input is a small object with a type, a default, and
     * sometimes a list of options, and it is only ever read whole with the
     * version. The order is the form's order.
     */
    dispatch_inputs: {
      order: 38,
      fillable: true,
      validation: { rule: schema.string().max(16_000) },
      factory: () => null,
    },

    /**
     * `env:` at the workflow level, as JSON.
     *
     * Read whole with the version and never queried across workflows, so a
     * column rather than rows. The three levels are stored apart rather than
     * merged at parse time because [the precedence](../Actions/Workflow/env.ts)
     * is a rule a reader has to be able to check, and a merged blob cannot say
     * which level a value came from.
     */
    env: {
      order: 39,
      fillable: true,
      validation: { rule: schema.string().max(16_000) },
      factory: () => null,
    },

    /**
     * `permissions:` as written, as JSON.
     *
     * Stored unresolved so a screen can say what the file asked for as well as
     * what it got. Null means the key was absent, which is not `{}` - that is a
     * workflow asking for no permissions at all, deliberately.
     */
    permissions: {
      order: 40,
      fillable: true,
      validation: { rule: schema.string().max(4000) },
      factory: () => null,
    },

    /** `defaults.run.shell` at the workflow level. Steps inherit it. */
    default_shell: {
      order: 41,
      fillable: true,
      validation: { rule: schema.string().max(200) },
      factory: () => null,
    },

    /** `defaults.run.working-directory` at the workflow level. */
    default_working_directory: {
      order: 42,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    /**
     * The issue and release triggers, with the activity types each names.
     *
     * One column per event rather than a shared table: they are read together
     * with the version, always, and a workflow triggering on issues is rare
     * enough that three nullable columns cost less than a join.
     */
    on_issues: {
      order: 43,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    issue_types: {
      order: 44,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    on_issue_comment: {
      order: 45,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    issue_comment_types: {
      order: 46,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    on_release: {
      order: 47,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    release_types: {
      order: 48,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    /**
     * `repository_dispatch`: started by a program rather than by anything that
     * happened here.
     *
     * The trigger a pipeline outside this instance reaches for. Its filter is
     * the `event_type` the caller sends, and a workflow that names no types
     * takes every one - which is Actions' rule and the one people expect.
     */
    on_repository_dispatch: {
      order: 49,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    repository_dispatch_types: {
      order: 50,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    /**
     * `workflow_run`: this workflow starts when another one finishes.
     *
     * Why it exists rather than being expressed with `needs:`: the second
     * workflow can be one a fork's pull request may not touch, so a build from
     * an untrusted run is published by something the fork could not edit.
     */
    on_workflow_run: {
      order: 51,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /** Which workflows it waits for, by name, one per line. */
    workflow_run_workflows: {
      order: 52,
      fillable: true,
      validation: { rule: schema.string().max(1000) },
      factory: () => null,
    },

    /** `completed` or `requested`, one per line. Empty means `completed`. */
    workflow_run_types: {
      order: 53,
      fillable: true,
      validation: { rule: schema.string().max(200) },
      factory: () => null,
    },

    /** `branches:` on the *triggering* run's ref, one per line. */
    workflow_run_branches: {
      order: 54,
      fillable: true,
      validation: { rule: schema.string().max(1000) },
      factory: () => null,
    },

    /**
     * What a caller may pass this workflow, and what it gets back, as JSON.
     *
     * Only meaningful on a version whose `on:` names `workflow_call`. Stored
     * with the version because a caller resolves against the *called
     * workflow's registered definition*, not against whatever its file says
     * today - the same rule the fork policy applies to a pull request.
     */
    call_inputs: {
      order: 49,
      fillable: true,
      validation: { rule: schema.string().max(16_000) },
      factory: () => null,
    },

    call_outputs: {
      order: 50,
      fillable: true,
      validation: { rule: schema.string().max(16_000) },
      factory: () => null,
    },

    call_secrets: {
      order: 51,
      fillable: true,
      validation: { rule: schema.string().max(8000) },
      factory: () => null,
    },

    /**
     * What this instance does differently with this file, as JSON.
     *
     * Recorded with the version rather than recomputed for a page, because the
     * answer belongs to the file as it was parsed: a workflow registered before
     * a key was implemented should keep saying what it said until it is pushed
     * again, which is when its author is looking.
     */
    warnings: {
      order: 52,
      fillable: true,
      validation: { rule: schema.string().max(16_000) },
      factory: () => null,
    },

    /** Cron expressions, one per line. */
    schedules: {
      order: 15,
      fillable: true,
      validation: { rule: schema.string().max(2000) },
      factory: () => null,
    },

    /**
     * Real Actions events this instance does not dispatch on yet.
     *
     * Recorded so the interface can say "this workflow also fires on `release`,
     * which is not implemented here" rather than silently never running it -
     * which reads as a broken workflow.
     */
    unsupported_events: {
      order: 16,
      fillable: true,
      validation: { rule: schema.string().max(1000) },
      factory: () => null,
    },
  },
})
