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
