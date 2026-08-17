import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A named body of tests in a repository: `unit`, `browser`, `integration`.
 *
 * The unit a person thinks in when they say "the tests are flaky again", and
 * the unit reliability is worth reporting over - a repository-wide number mixes
 * a browser suite that fails on a slow morning with a unit suite that does not,
 * and the average is true of neither.
 *
 * **Ingestion works for a repository whose CI is somewhere else.** That is the
 * shape worth copying from Buildkite's test product: it takes results from any
 * CI, so a team can get the flake detection before they move their pipelines.
 */
export default defineModel({
  name: 'TestSuite',
  table: 'test_suites',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'test_suites_repository_index', columns: ['repository_id', 'slug'], unique: true },
  ],

  traits: { useUuid: true, useTimestamps: true, useSeeder: { count: 0 } },

  belongsTo: [{ model: 'Repository', onDelete: 'cascade' }],

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    name: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(100) },
      factory: () => 'unit',
    },

    /** What a URL and an ingest call name it by. */
    slug: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required().max(100) },
      factory: () => 'unit',
    },
  },
} as const)
