import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One reported check on one commit.
 *
 * ReviewOS does not run CI. It accepts reports from whatever does, which is the
 * part that matters for review: a branch rule names the checks it requires, and
 * the merge button consults the latest report for each of them.
 *
 * Runs are recorded against a commit rather than a pull request, so the same
 * report serves every pull request whose head is that commit, and a run stays
 * meaningful after the branch moves — see `staleRunsFor`, which is how a force
 * push stops inheriting the previous head's green ticks.
 */
export default defineModel({
  name: 'CheckRun',
  table: 'check_runs',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'check_runs_head_index', columns: ['repository_id', 'head_sha'] },
    { name: 'check_runs_name_index', columns: ['repository_id', 'name'] },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 25 },
  },

  belongsTo: ['Repository'],

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    head_sha: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().min(40).max(40) },
      factory: faker => faker.git.commitSha(),
    },

    name: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required().max(255) },
      factory: faker => faker.helpers.arrayElement(['build', 'test', 'lint', 'typecheck']),
    },

    status: {
      order: 4,
      fillable: true,
      default: 'queued',
      validation: { rule: schema.enum(['queued', 'in_progress', 'completed']) },
      factory: () => 'completed',
    },

    /**
     * Null until the run completes.
     *
     * `neutral` and `skipped` count as passing: a check that decided it had
     * nothing to say about this commit has not found a problem.
     */
    conclusion: {
      order: 5,
      fillable: true,
      validation: {
        rule: schema.enum([
          'success',
          'failure',
          'neutral',
          'cancelled',
          'timed_out',
          'action_required',
          'skipped',
          'stale',
        ]),
      },
      factory: faker => faker.helpers.arrayElement(['success', 'success', 'success', 'failure', 'neutral']),
    },

    /** Where the person clicking through ends up. */
    details_url: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(2048) },
      factory: faker => `https://${faker.internet.domainName()}/runs/${faker.string.alphanumeric(8)}`,
    },

    summary: {
      order: 7,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: faker => faker.lorem.sentence(),
    },

    started_at: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string() },
      factory: faker => faker.date.recent().toISOString(),
    },

    completed_at: {
      order: 9,
      fillable: true,
      validation: { rule: schema.string() },
      factory: faker => faker.date.recent().toISOString(),
    },
  },
} as const)
