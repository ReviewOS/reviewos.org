import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A workflow as a resource, separate from any version of it.
 *
 * The row that survives editing. What a run points at is a
 * `WorkflowVersion` - an immutable snapshot of one commit's definition - so
 * inspecting a run from six months ago shows the workflow *as it ran*, not
 * whatever is in the default branch today. That distinction is the reason this
 * is two models rather than one, and it is the difference between a CI history
 * you can audit and one that quietly rewrites itself.
 *
 * **A workflow may belong to no repository.** `repository_id` is nullable
 * because an owner can carry one that matches every repository under them, or a
 * selector over them: a licence check or a secret scan that lands on two
 * hundred repositories without two hundred commits, and that cannot be removed
 * by editing a file in one of them. Those run at the owner's trust level over
 * the repository's data, never at the repository's - which is what makes it
 * safe to give one a secret.
 */
export default defineModel({
  name: 'Workflow',
  table: 'workflows',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // Every dispatch starts here: what does this repository have.
    { name: 'workflows_repository_index', columns: ['repository_id', 'state'] },
    // And the owner-wide ones, which carry no repository at all.
    { name: 'workflows_owner_index', columns: ['owner_type', 'owner_id', 'state'] },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  /**
   * Declared for the cascade, not for the requirement.
   *
   * `repository_id` stays nullable because its validation does not say
   * `required` - the relation is optional, which is what an owner-wide workflow
   * needs. Without the relation the generator emits a plain `REFERENCES` with
   * no `ON DELETE`, and deleting a repository that has a workflow then fails on
   * the constraint: a repository nobody can remove because CI once ran on it.
   */
  belongsTo: [{ model: 'Repository', onDelete: 'cascade' }],

  attributes: {
    owner_type: {
      order: 1,
      fillable: true,
      validation: { rule: schema.enum(['user', 'organization']) },
      factory: () => 'organization',
    },

    owner_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /**
     * The repository this belongs to, or null for an owner-wide workflow.
     *
     * Not a `belongsTo`, because the relation is optional and a required
     * foreign key would make the owner-wide case unrepresentable - which is the
     * case this column exists for.
     */
    repository_id: {
      order: 3,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** `.github/workflows/ci.yml`. Null when the owner defines it out of band. */
    path: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(400) },
      factory: () => '.github/workflows/ci.yml',
    },

    /** The `name:` in the file, or the file name when it has none. */
    name: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().required().max(200) },
      factory: () => 'CI',
    },

    /**
     * Disabled is a first-class state rather than a deletion.
     *
     * A workflow that is failing at three in the morning gets turned off, and
     * the runs it already produced have to stay inspectable - which deleting
     * the row would take with it.
     *
     * `removed` is a third state and not a synonym for `disabled`: the file is
     * no longer in the tree. The two have to be told apart because they behave
     * differently when the file comes back - a workflow somebody turned off
     * stays off, and one whose file was deleted and restored runs again. One
     * state for both would mean a revert quietly resurrecting a workflow a
     * person had switched off on purpose.
     */
    state: {
      order: 6,
      fillable: true,
      default: 'active',
      validation: { rule: schema.enum(['active', 'disabled', 'removed']) },
      factory: () => 'active',
    },

    /**
     * Which repositories an owner-wide workflow covers.
     *
     * Null means every repository under the owner. A selector is stored as
     * written so that a repository created tomorrow is matched by the same rule
     * rather than by a list that was expanded once.
     */
    selector: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().max(1000) },
      factory: () => null,
    },
  },
})
