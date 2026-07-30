import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** A label applied to an issue or pull request. */
export default defineModel({
  name: 'IssueLabel',
  table: 'issue_labels',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'issue_labels_issue_index', columns: ['issue_id', 'label_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 40 },
  },

  belongsTo: ['Issue', { model: 'RepositoryLabel', foreignKey: 'label_id' }],

  attributes: {
    issue_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    label_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },
  },
} as const)
