import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'ProjectColumn',
  table: 'project_columns',
  primaryKey: 'id',
  autoIncrement: true,
  traits: { useTimestamps: true, useSeeder: { count: 0 } },
  belongsTo: [
    { model: 'Repository', foreignKey: 'repository_id', onDelete: 'cascade' },
    { model: 'Project', foreignKey: 'project_id', onDelete: 'cascade' },
  ],
  indexes: [
    { name: 'project_columns_project_position_index', columns: ['project_id', 'position'], unique: false },
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
    title: {
      order: 3,
      fillable: true,
      required: true,
      validation: { rule: schema.string().required().max(160) },
      factory: faker => faker.lorem.words(3),
    },
    position: {
      order: 4,
      fillable: true,
      default: 0,
      validation: { rule: schema.number().min(0) },
      factory: () => 1,
    },
  },
} as const)
