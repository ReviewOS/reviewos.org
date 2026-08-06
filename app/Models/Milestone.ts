import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** A milestone issues can be filed under. */
export default defineModel({
  name: 'Milestone',
  table: 'milestones',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'milestones_repo_index', columns: ['repository_id'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 8 },
  },

  belongsTo: [{ model: 'Repository', onDelete: 'cascade' }],

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    title: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(255) },
      factory: faker => `v${faker.number.int({ min: 1, max: 3 })}.${faker.number.int({ min: 0, max: 9 })}`,
    },

    description: {
      order: 3,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: faker => faker.lorem.sentence(),
    },

    due_on: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string() },
      factory: faker => faker.date.future().toISOString(),
    },

    state: {
      order: 5,
      fillable: true,
      default: 'open',
      validation: { rule: schema.enum(['open', 'closed']) },
      factory: () => 'open',
    },
  },
} as const)
