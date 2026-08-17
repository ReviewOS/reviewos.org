import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A variable a workflow can read, set at the instance, an owner, or a
 * repository.
 *
 * **Not a secret.** These are readable by anybody who can read the repository,
 * they appear in logs, and they are handed to every job - a fork's included.
 * Keeping the two apart in the model rather than behind a flag is deliberate:
 * a boolean called `secret` on a table that is otherwise plain text is a thing
 * somebody eventually forgets to check.
 *
 * The workflow file is the fourth level and has no row here: a value written
 * beside the job it applies to is the most specific statement anybody made
 * about it, and it lives where it is read.
 */
export default defineModel({
  name: 'WorkflowVariable',
  table: 'workflow_variables',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'workflow_variables_scope_index', columns: ['scope_type', 'scope_id', 'key'], unique: true },
  ],

  traits: { useUuid: true, useTimestamps: true, useSeeder: { count: 0 } },

  attributes: {
    /** `instance`, `owner`, or `repository`. Never `workflow`, which is the file. */
    scope_type: {
      order: 1,
      fillable: true,
      default: 'repository',
      validation: { rule: schema.enum(['instance', 'owner', 'repository']) },
      factory: () => 'repository',
    },

    /**
     * The owner or repository this belongs to. Zero for the instance.
     *
     * Zero rather than null because the unique index above is what stops one
     * key being set twice at the same level, and a null in a unique index does
     * not collide with another null - so nullable here would allow exactly the
     * duplicate it exists to prevent.
     */
    scope_id: {
      order: 2,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    key: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required().max(200) },
      factory: () => 'REGISTRY',
    },

    value: {
      order: 4,
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(4000) },
      factory: () => '',
    },
  },
})
