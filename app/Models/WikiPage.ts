import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'WikiPage',
  table: 'wiki_pages',
  primaryKey: 'id',
  autoIncrement: true,
  traits: { useTimestamps: true, useSeeder: { count: 0 } },
  belongsTo: [
    { model: 'Repository', foreignKey: 'repository_id', onDelete: 'cascade' },
  ],
  indexes: [
    { name: 'wiki_pages_repository_slug_index', columns: ['repository_id', 'slug'], unique: true },
  ],
  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      required: true,
      validation: { rule: schema.number().min(0) },
      factory: () => 1,
    },
    slug: {
      order: 2,
      fillable: true,
      required: true,
      validation: { rule: schema.string().required().max(120) },
      factory: faker => faker.lorem.slug(),
    },
    title: {
      order: 3,
      fillable: true,
      required: true,
      validation: { rule: schema.string().required().max(160) },
      factory: faker => faker.lorem.words(3),
    },
    body: {
      order: 4,
      fillable: true,
      type: 'text',
      default: '',
      validation: { rule: schema.string() },
      factory: () => '',
    },
    revision: {
      order: 5,
      fillable: true,
      default: 1,
      validation: { rule: schema.number().min(0) },
      factory: () => 1,
    },
    is_deleted: {
      order: 6,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },
  },
} as const)
