import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A place a repository deploys to, and the rules for getting there.
 *
 * `environment: production` on a job is the line everybody writes and almost
 * nobody checks. Parsing the key and running the job anyway is worse than
 * refusing it: the workflow says the deploy is protected, the run screen shows
 * an environment, and nothing is enforced.
 *
 * An environment that does not exist here is not protected, deliberately.
 * `environment: staging` in a repository with no `staging` is a label a
 * workflow author used for their own documentation, and refusing to run it
 * would break most workflows that use the key at all.
 */
export default defineModel({
  name: 'Environment',
  table: 'environments',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'environments_name_index', columns: ['repository_id', 'name'], unique: true },
  ],

  traits: { useUuid: true, useTimestamps: true, useSeeder: { count: 0 } },

  belongsTo: [{ model: 'Repository', onDelete: 'cascade' }],

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** What the workflow says: `production`, `staging`. */
    name: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(120) },
      factory: () => 'production',
    },

    /**
     * Minutes a job waits after it becomes ready.
     *
     * The window somebody uses to cancel a deploy they just realised is wrong,
     * and it releases itself - a timer that needs a person to end it is a
     * second approval wearing a clock.
     */
    wait_minutes: {
      order: 3,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    /**
     * Which refs may deploy here, comma separated. `main`, `release/*`.
     *
     * Empty allows any branch. A ref outside the list is **refused**, not
     * held: waiting for an approval that must not be given is worse than a
     * clear no, and a reviewer repeatedly asked to approve deploys from the
     * wrong branch will eventually approve one.
     */
    branches: {
      order: 4,
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(1000) },
      factory: () => '',
    },

    /** A sentence for the people who arrive at the approval and wonder what this is. */
    /**
     * Whether a deploy here waits for the commit's required checks.
     *
     * Off by default, because an environment is often a preview and a preview
     * that waits for the whole suite is a preview nobody sees until the suite
     * is green - which is exactly when they no longer need it.
     *
     * On, it is the rule people assume already exists: production does not
     * receive a commit whose tests have not passed. A *failed* required check
     * refuses the deploy rather than holding it, because waiting for a verdict
     * that has already arrived is a job nobody can unstick; a check still
     * running holds, which is what waiting is for.
     */
    require_checks: {
      order: 6,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    description: {
      order: 5,
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(500) },
      factory: () => '',
    },
  },
})
