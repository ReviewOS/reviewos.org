import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * How many bytes of one language a repository holds.
 *
 * **A breakdown rather than a single `language` column**, which the roadmap
 * asks for and is the right shape: a repository is rarely one language, and the
 * column version forces a choice that is wrong for every repository with a
 * frontend and a backend. It also makes "browse by language" a join rather than
 * a scan, and answers "how much Go is in here" without opening the tree.
 *
 * Rows are replaced wholesale when a repository is re-measured. A language that
 * has left the repository must leave the breakdown, and merging would keep it
 * there forever - which is exactly how a repository that was rewritten in Rust
 * goes on being listed under Ruby.
 */
export default defineModel({
  name: 'RepositoryLanguage',
  table: 'repository_languages',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // The two reads: this repository's breakdown, and every repository in a
    // language.
    { name: 'repository_languages_repo_index', columns: ['repository_id', 'bytes'] },
    { name: 'repository_languages_language_index', columns: ['language', 'bytes'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  belongsTo: [{ model: 'Repository', onDelete: 'cascade' }],

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** As it is written for a person: `TypeScript`, not `ts`. */
    language: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(60) },
      factory: () => 'TypeScript',
    },

    /**
     * Bytes, not files.
     *
     * A repository with forty small YAML files and one large Go program is a Go
     * repository, and counting files says it is YAML. The difference is not
     * marginal: configuration and lock files outnumber source files in most
     * modern projects.
     */
    bytes: {
      order: 3,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => 0,
    },

    /**
     * Of the identified code, so the numbers add to a hundred.
     *
     * Stored rather than computed on read, because every reader would otherwise
     * have to sum the rows first - and a breakdown whose percentages do not add
     * up is one nobody trusts twice.
     */
    percent: {
      order: 4,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => 0,
    },
  },
} as const)
