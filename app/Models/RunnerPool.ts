import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A named group of queues, and the repositories allowed to use them.
 *
 * The isolation boundary a fleet needs and a list of runners does not have.
 * Without it, every machine an operator registers is reachable by every
 * repository on the instance: a runner bought for the deployment pipeline,
 * holding the credentials that pipeline needs, takes a pull request check from
 * a repository that has nothing to do with it, and the two are only separated
 * by whichever labels somebody remembered to write.
 *
 * **A pool with no repositories listed is unrestricted.** That is what every
 * existing install has, and it keeps meaning what it means today: an operator
 * who has not thought about pools has not been quietly given a boundary they
 * did not ask for. Listing one repository is the act of drawing the boundary,
 * and from then on the pool serves that list and nothing else.
 *
 * Pools are an instance-level object. An organization-level pool is a real
 * thing to want and is a different decision - who may create one, who pays for
 * it - and inventing it here would be answering that question in the model
 * before anybody has asked it.
 */
export default defineModel({
  name: 'RunnerPool',
  table: 'runner_pools',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'runner_pools_slug_index', columns: ['slug'], unique: true },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  attributes: {
    /** What a person calls it: `Deployment`. */
    name: {
      order: 1,
      fillable: true,
      validation: { rule: schema.string().required().max(100) },
      factory: () => 'default',
    },

    /** What a URL and a command line call it: `deployment`. */
    slug: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(100) },
      factory: () => 'default',
    },

    /**
     * What this pool is for, in the operator's own words.
     *
     * A fleet accumulates pools whose reason for existing was obvious to
     * whoever made them and to nobody afterwards, and "why can this pool reach
     * that repository" is asked at exactly the wrong moment otherwise.
     */
    description: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().max(1000) },
      factory: () => null,
    },
  },
} as const)
