import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One step in a job's definition.
 *
 * `command` and `uses` are **inert text**. Storing a step is not preparing to
 * run one: the control plane never evaluates either, and the only thing that
 * ever does is a runner on a machine the operator chose. That is the property
 * [the threat model](../../docs/ci-threat-model.md) rests on, and it is worth
 * stating on the column rather than only in the parser, because a column called
 * `command` invites somebody downstream to be helpful with it.
 *
 * Exactly one of the two is set, which the validator has already enforced -
 * a step that both runs a command and uses an action is refused before it can
 * reach a row.
 */
export default defineModel({
  name: 'WorkflowVersionStep',
  table: 'workflow_version_steps',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'workflow_version_steps_job_index', columns: ['workflow_version_job_id', 'position'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  belongsTo: [{ model: 'WorkflowVersionJob', onDelete: 'cascade' }],

  attributes: {
    workflow_version_job_id: {
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

    /** The step's `id:`, which later steps refer to for its outputs. */
    step_id: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().max(100) },
      factory: () => null,
    },

    name: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(200) },
      factory: () => null,
    },

    /**
     * The shell command, verbatim and unexecuted.
     *
     * Long, because a `run:` block is routinely a script. Truncating one would
     * store a command that differs from the one the author wrote, which is
     * worse than refusing it.
     */
    command: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(65_535) },
      factory: () => null,
    },

    /** `actions/checkout@v4`, recorded rather than resolved. */
    uses: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(400) },
      factory: () => null,
    },

    /** The `with:` mapping, as JSON. Arguments to an action are opaque here. */
    inputs: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().max(65_535) },
      factory: () => null,
    },

    /** `env:` on the step, as JSON. The narrowest level, so it wins. */
    env: {
      order: 20,
      fillable: true,
      validation: { rule: schema.string().max(16_000) },
      factory: () => null,
    },

    /** `shell:` as written. Null means inherit rather than bash. */
    shell: {
      order: 21,
      fillable: true,
      validation: { rule: schema.string().max(200) },
      factory: () => null,
    },

    /** `continue-on-error:`: this step fails and the job carries on. */
    continue_on_error: {
      order: 22,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    working_directory: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string().max(400) },
      factory: () => null,
    },

    /** The `if:` expression, stored unevaluated. */
    condition: {
      order: 9,
      fillable: true,
      validation: { rule: schema.string().max(1000) },
      factory: () => null,
    },
  },
})
