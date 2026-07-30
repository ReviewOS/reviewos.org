import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** Somebody assigned to an issue or pull request. */
export default defineModel({
  name: 'IssueAssignee',
  table: 'issue_assignees',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
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
  },
} as const)
