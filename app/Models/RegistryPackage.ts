import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/** Names remain reserved after deletion, so a new repository cannot inherit private artifacts. */
export default defineModel({
  name: 'RegistryPackage',
  table: 'registry_packages',
  primaryKey: 'id',
  autoIncrement: true,
  traits: { useTimestamps: true, useSeeder: { count: 0 } },
  belongsTo: [
    { model: 'Repository', foreignKey: 'repository_id', onDelete: 'set null' },
  ],
  indexes: [
    { name: 'registry_packages_name_index', columns: ['name'], unique: true },
    { name: 'registry_packages_repository_index', columns: ['repository_id'], unique: false },
  ],
  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      nullable: true,
      validation: { rule: schema.number().min(1) },
      factory: () => 1,
    },
    name: {
      order: 2,
      fillable: true,
      required: true,
      validation: { rule: schema.string().required().max(214) },
      factory: faker => `@example/${faker.lorem.slug()}`,
    },
  },
} as const)
