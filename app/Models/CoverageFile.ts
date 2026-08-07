import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One file's line coverage, at one commit.
 *
 * Keyed by commit rather than by pull request, exactly as check runs are: one
 * CI report serves every pull request whose head is that commit, and a
 * force-push naturally orphans the old report rather than mislabeling the
 * new code with it.
 *
 * Both line sets are stored, but only `uncovered_lines` is read today: the
 * diff marks changed lines no test executes. `covered_lines` is kept because
 * the difference between "this line is covered" and "the report did not
 * mention this line" is real - a file the report skips must render as
 * unknown, never as covered - and dropping the covered set would collapse
 * the two.
 */
export default defineModel({
  name: 'CoverageFile',
  table: 'coverage_files',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // One answer per file per commit: an upload replaces, never accumulates.
    { name: 'coverage_files_repo_sha_path_index', columns: ['repository_id', 'commit_sha', 'path'], unique: true },
    // The read the diff makes: everything for one commit.
    { name: 'coverage_files_repo_sha_index', columns: ['repository_id', 'commit_sha'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 10 },
  },

  belongsTo: [
    { model: 'Repository', onDelete: 'cascade' },
  ],

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    commit_sha: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().min(40).max(40) },
      factory: faker => faker.git.commitSha(),
    },

    path: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required().max(1024) },
      factory: faker => `src/${faker.hacker.noun()}.ts`,
    },

    uncovered_lines: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(1048576) },
      factory: () => '[]',
    },

    covered_lines: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(1048576) },
      factory: () => '[]',
    },
  },
} as const)
