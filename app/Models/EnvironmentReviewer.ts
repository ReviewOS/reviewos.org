import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Somebody who may approve a deploy to one environment.
 *
 * A row rather than a count, because "two approvals required" is a rule about
 * how many people, and this is a rule about *which* people - and the second is
 * the one that stops a deploy going out on a Sunday because the only person who
 * understood it was asleep.
 *
 * The person who started the run may not approve it, whoever they are. That
 * check lives with the decision in `app/Actions/Workflow/environments.ts`,
 * because a required reviewer who can approve their own deploy is a rule that
 * reads as two people and behaves as one.
 */
export default defineModel({
  name: 'EnvironmentReviewer',
  table: 'environment_reviewers',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'environment_reviewers_repository_index', columns: ['repository_id'] },
    { name: 'environment_reviewers_unique', columns: ['environment_id', 'user_id'], unique: true },
  ],

  traits: { useUuid: true, useTimestamps: true, useSeeder: { count: 0 } },

  belongsTo: [{ model: 'Environment', onDelete: 'cascade' }, 'User'],

  attributes: {
    environment_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    user_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /**
     * The repository this belongs to, copied from its environment.
     *
     * Denormalized, and the duplication is the point: this is the column a
     * sharded keyspace routes on, and Vitess cannot follow a foreign key to
     * find it. Without it this table lands in the unsharded keyspace, and every
     * transaction touching it and its environment crosses keyspaces - the one
     * thing sharding by repository was chosen to avoid.
     *
     * Written where the row is created, from the parent already in hand.
     * `buddy db:keyspaces --check` is what notices when it is not.
     */
    repository_id: {
      order: 90,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
})
