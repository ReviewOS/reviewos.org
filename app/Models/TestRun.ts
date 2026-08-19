import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One reported execution of a suite, against one commit.
 *
 * Tied to a commit rather than to a workflow run, because the point is to work
 * for a repository whose CI is somewhere else: a team running tests on another
 * system can post results here and get flake detection before they move a
 * single pipeline. When the run *did* happen here, the workflow run is recorded
 * too, so a failure has a log to open.
 *
 * **`external_key` is what makes reporting twice safe.** A collector that
 * retries - and every collector retries, because the network is what it is -
 * must not double every test's history. Same key, same run.
 */
export default defineModel({
  name: 'TestRun',
  table: 'test_runs',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'test_runs_repository_index', columns: ['repository_id'] },
    { name: 'test_runs_suite_index', columns: ['test_suite_id', 'id'] },
    { name: 'test_runs_commit_index', columns: ['test_suite_id', 'head_sha'] },
    { name: 'test_runs_key_index', columns: ['test_suite_id', 'external_key'], unique: true },
  ],

  traits: { useUuid: true, useTimestamps: true, useSeeder: { count: 0 } },

  belongsTo: [{ model: 'TestSuite', onDelete: 'cascade' }],

  attributes: {
    test_suite_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** The commit the tests ran against. */
    head_sha: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().max(64) },
      factory: () => 'a'.repeat(40),
    },

    branch: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: () => null,
    },

    /** The pull request, when the reporter said there was one. */
    pull_request_id: {
      order: 4,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** The run on this instance, when the tests ran here. */
    workflow_run_id: {
      order: 5,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /**
     * The reporter's own identifier for this run.
     *
     * Idempotency: a collector that retries must not double a test's history,
     * and every collector retries.
     */
    external_key: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(200) },
      factory: () => null,
    },

    /** `junit` or `json`, so a malformed report can be traced to its shape. */
    source: {
      order: 7,
      fillable: true,
      default: 'json',
      validation: { rule: schema.enum(['junit', 'json']) },
      factory: () => 'json',
    },

    /*
     * Counted at ingest rather than at read time. A suite with fifty thousand
     * executions should not need to aggregate them to answer "did this run
     * pass", which is the question every screen asks first.
     */
    passed: { order: 8, fillable: true, default: 0, validation: { rule: schema.number() }, factory: () => 0 },
    failed: { order: 9, fillable: true, default: 0, validation: { rule: schema.number() }, factory: () => 0 },
    skipped: { order: 10, fillable: true, default: 0, validation: { rule: schema.number() }, factory: () => 0 },

    /**
     * Failures from muted tests, counted apart.
     *
     * The number that makes muting honest: the run's verdict ignores these, and
     * the screen still says how many there were. A mute that hid the count
     * would be a suite quietly testing less than it says.
     */
    muted_failures: { order: 11, fillable: true, default: 0, validation: { rule: schema.number() }, factory: () => 0 },

    duration_ms: { order: 12, fillable: true, default: 0, validation: { rule: schema.number() }, factory: () => 0 },

    /**
     * The repository this belongs to, copied from its test suite.
     *
     * Denormalized, and the duplication is the point: this is the column a
     * sharded keyspace routes on, and Vitess cannot follow a foreign key to
     * find it. Without it this table lands in the unsharded keyspace, and every
     * transaction touching it and its test suite crosses keyspaces - the one
     * thing sharding by repository was chosen to avoid.
     *
     * Written where the row is created, from the parent already in hand.
     * `buddy db:keyspaces --check` is what notices when it is not.
     */
    repository_id: {
      order: 90,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
} as const)
