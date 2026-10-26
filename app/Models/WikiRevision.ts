import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'WikiRevision',
  table: 'wiki_revisions',
  primaryKey: 'id',
  autoIncrement: true,
  traits: { useTimestamps: true, useSeeder: { count: 0 } },
  belongsTo: [
    { model: 'Repository', foreignKey: 'repository_id', onDelete: 'cascade' },
    { model: 'WikiPage', foreignKey: 'wiki_page_id', onDelete: 'cascade' },
    { model: 'User', foreignKey: 'author_id', onDelete: 'set null' },
  ],
  indexes: [
    { name: 'wiki_revisions_page_revision_index', columns: ['wiki_page_id', 'revision'], unique: true },
  ],
  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      required: true,
      validation: { rule: schema.number().min(0) },
      factory: () => 1,
    },
    wiki_page_id: {
      order: 2,
      fillable: true,
      required: true,
      validation: { rule: schema.number().min(0) },
      factory: () => 1,
    },
    author_id: {
      order: 3,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => 1,
    },
    revision: {
      order: 4,
      fillable: true,
      required: true,
      validation: { rule: schema.number().min(0) },
      factory: () => 1,
    },
    title: {
      order: 5,
      fillable: true,
      required: true,
      validation: { rule: schema.string().required().max(160) },
      factory: faker => faker.lorem.words(3),
    },
    body: {
      order: 6,
      fillable: true,
      type: 'text',
      default: '',
      validation: { rule: schema.string() },
      factory: () => '',
    },
    summary: {
      order: 7,
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(255) },
      factory: () => '',
    },
    is_deleted: {
      order: 8,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },
  },
} as const)
