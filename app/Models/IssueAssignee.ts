import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** Somebody assigned to an issue or pull request. */
export default defineModel({
  name: 'IssueAssignee',
  table: 'issue_assignees',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'issue_assignees_repository_index', columns: ['repository_id'] },
    { name: 'issue_assignees_issue_index', columns: ['issue_id', 'user_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 25 },
  },

  belongsTo: ['Issue', 'User'],

  attributes: {
    issue_id: {
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
     * The repository this belongs to, copied from its issue.
     *
     * Denormalized, and the duplication is the point: this is the column a
     * sharded keyspace routes on, and Vitess cannot follow a foreign key to
     * find it. Without it this table lands in the unsharded keyspace, and every
     * transaction touching it and its issue crosses keyspaces - the one
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
} as const)
