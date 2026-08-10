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
    /*
     * The idempotency key, unique across the table.
     *
     * A CI system that retries a create - because the connection dropped after
     * the row was written but before the response arrived - must get the same
     * run back rather than a second one. Enforced by the database rather than
     * by a check-then-insert, because two workers retrying at once would both
     * find nothing and both insert.
     */
    { name: 'check_runs_idempotency_index', columns: ['idempotency_key'], unique: true },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 25 },
  },

  belongsTo: [{ model: 'Repository', onDelete: 'cascade' }],

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

    /**
     * Who reported it, so a wrong verdict has an author.
     *
     * A check run blocks a merge. "The build says no" is not actionable until
     * somebody can find out *which* build, run by whose credential - and on an
     * instance with three CI systems posting under similar names, that is the
     * first question asked.
     */
    reporter_id: {
      order: 10,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** The system that reported: `buildkite`, `woodpecker`, a script's name. */
    provider: {
      order: 11,
      fillable: true,
      validation: { rule: schema.string().max(100) },
      factory: () => null,
    },

    /**
     * The run's id in that system, so a link back is possible after the fact.
     *
     * `details_url` is where a person clicks; this is what a program matches on
     * when it comes back to update a run it started and no longer has our id.
     */
    external_id: {
      order: 12,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: () => null,
    },

    /**
     * The key a retried create is recognised by.
     *
     * Unique in the database rather than checked before inserting: two workers
     * retrying at the same moment would both find nothing and both insert, and
     * the second run would sit `queued` forever, blocking a merge on a check
     * that no longer exists anywhere.
     */
    idempotency_key: {
      order: 13,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: () => null,
    },

    /** A headline for the output, shown where a summary is too long. */
    output_title: {
      order: 14,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: () => null,
    },

    /** The full output, which is the log somebody reads before the details link. */
    output_text: {
      order: 15,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: () => null,
    },

    /**
     * Which attempt this is, so repeated runs of one check order stably.
     *
     * A CI system that re-runs a failed job posts a second run under the same
     * name, and "the latest" has to mean the latest *attempt* rather than
     * whichever row the database returned first. Ordering by id would usually
     * agree and would stop agreeing exactly when two systems report out of
     * order, which is when somebody is already confused.
     */
    attempt: {
      order: 16,
      fillable: true,
      default: 1,
      validation: { rule: schema.number() },
      factory: () => 1,
    },
  },
} as const)
