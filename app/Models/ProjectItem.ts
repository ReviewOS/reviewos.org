import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'ProjectItem',
  table: 'project_items',
  primaryKey: 'id',
  autoIncrement: true,
  traits: { useTimestamps: true, useSeeder: { count: 0 } },
  belongsTo: [
    { model: 'Repository', foreignKey: 'repository_id', onDelete: 'cascade' },
    { model: 'Project', foreignKey: 'project_id', onDelete: 'cascade' },
    { model: 'ProjectColumn', foreignKey: 'project_column_id', onDelete: 'cascade' },
    { model: 'Issue', foreignKey: 'issue_id', onDelete: 'cascade' },
  ],
  indexes: [
    { name: 'project_items_project_issue_index', columns: ['project_id', 'issue_id'], unique: true },
    { name: 'project_items_column_position_index', columns: ['project_column_id', 'position'], unique: false },
  ],
  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      required: true,
      validation: { rule: schema.number().min(0) },
      factory: () => 1,
    },
    project_id: {
      order: 2,
      fillable: true,
      required: true,
      validation: { rule: schema.number().min(0) },
      factory: () => 1,
    },
    project_column_id: {
      order: 3,
      fillable: true,
      required: true,
      validation: { rule: schema.number().min(0) },
      factory: () => 1,
    },
    issue_id: {
      order: 4,
      fillable: true,
      required: true,
      validation: { rule: schema.number().min(0) },
      factory: () => 1,
    },
    position: {
      order: 5,
      fillable: true,
      default: 0,
      validation: { rule: schema.number().min(0) },
      factory: () => 1,
    },
    revision: {
      order: 6,
      fillable: true,
      default: 1,
      validation: { rule: schema.number().min(0) },
      factory: () => 1,
    },
  },
} as const)
