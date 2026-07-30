import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A repository label.
 *
 * Labels belong to a repository rather than being global: `bug` means something
 * different in every project, and a shared vocabulary imposed across
 * repositories is one nobody uses.
 *
 * Named `RepositoryLabel` rather than `Label` because the framework ships its
 * own board `Label`, and two models sharing a table name means whichever
 * migration runs second inherits the other's columns.
 *
 * The colour is stored without its leading `#` so it can be dropped into either
 * a CSS value or a hex comparison without a strip step at each use.
 */
export default defineModel({
  name: 'RepositoryLabel',
  table: 'repository_labels',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'repository_labels_repository_name_index', columns: ['repository_id', 'name'] },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 20 },
  },

  belongsTo: ['Repository'],

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
      validation: { rule: schema.string().required().min(1).max(50) },
      factory: faker => faker.helpers.arrayElement([
        'bug',
        'enhancement',
        'documentation',
        'good first issue',
        'help wanted',
        'question',
        'wontfix',
        'duplicate',
      ]),
    },

    /** Six hex digits, no leading hash. */
    color: {
      order: 3,
      fillable: true,
      default: 'd4c5f9',
      validation: { rule: schema.string().required().min(6).max(6) },
      factory: faker => faker.color.rgb({ prefix: '', casing: 'lower' }).slice(0, 6),
    },

    description: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: faker => faker.lorem.sentence(),
    },

    /**
     * True for the labels created with every repository.
     *
     * Kept so the defaults can be recognised later: a repository that has
     * renamed `bug` has made a decision, and a future change to the default set
     * must not undo it.
     */
    is_default: {
      order: 5,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },
  },
} as const)
