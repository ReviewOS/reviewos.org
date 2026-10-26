import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'Project',
  table: 'projects',
  primaryKey: 'id',
  autoIncrement: true,
  traits: { useTimestamps: true, useSeeder: { count: 0 } },
  belongsTo: [
    { model: 'Repository', foreignKey: 'repository_id', onDelete: 'cascade' },
  ],
  indexes: [
    { name: 'projects_repository_state_index', columns: ['repository_id', 'state'], unique: false },
  ],
  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      required: true,
      validation: { rule: schema.number().min(0) },
      factory: () => 1,
    },
    title: {
      order: 2,
      fillable: true,
      required: true,
      validation: { rule: schema.string().required().max(160) },
      factory: faker => faker.lorem.words(3),
    },
    description: {
      order: 3,
      fillable: true,
      type: 'text',
      default: '',
      validation: { rule: schema.string() },
      factory: () => '',
    },
    state: {
      order: 4,
      fillable: true,
      default: 'open',
      validation: { rule: schema.enum(['open', 'closed']) },
      factory: () => 'open',
    },
    revision: {
      order: 5,
      fillable: true,
      default: 1,
      validation: { rule: schema.number().min(0) },
      factory: () => 1,
    },
  },
} as const)
