import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * What one test did, in one run.
 *
 * The row flake detection reads and the row a person opens when a test fails:
 * the message, the stack, how long it took, how many times the reporter had to
 * retry it, and which job it ran in.
 *
 * Retries are recorded rather than collapsed. A test that passed on its third
 * attempt did not pass - it is the definition of flaky, and a tool that stores
 * only the final verdict has thrown away the fact before anybody can act on it.
 */
export default defineModel({
  name: 'TestExecution',
  table: 'test_executions',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'test_executions_repository_index', columns: ['repository_id'] },
    { name: 'test_executions_run_index', columns: ['test_run_id'] },
    // The flake query: this test's recent history, newest first.
    { name: 'test_executions_test_index', columns: ['managed_test_id', 'id'] },
  ],

  traits: { useUuid: true, useTimestamps: true, useSeeder: { count: 0 } },

  belongsTo: [{ model: 'TestRun', onDelete: 'cascade' }, { model: 'ManagedTest', onDelete: 'cascade' }],

  attributes: {
    test_run_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    managed_test_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** `passed`, `failed`, or `skipped`, as the reporter said it. */
    result: {
      order: 3,
      fillable: true,
      default: 'passed',
      validation: { rule: schema.enum(['passed', 'failed', 'skipped']) },
      factory: () => 'passed',
    },

    duration_ms: { order: 4, fillable: true, default: 0, validation: { rule: schema.number() }, factory: () => 0 },

    /** How many attempts the reporter needed. One means it ran once. */
    retries: { order: 5, fillable: true, default: 0, validation: { rule: schema.number() }, factory: () => 0 },

    failure_message: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(4000) },
      factory: () => null,
    },

    failure_stack: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().max(20_000) },
      factory: () => null,
    },

    /** The job it ran in, so a failure has a log to open. */
    workflow_job_id: {
      order: 8,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /**
     * `key=value` dimensions, one per line.
     *
     * What the run was: `shard=3`, `browser=firefox`, `os=linux`. A failure
     * that only happens on one of them is the most useful thing a suite can
     * tell you, and it is invisible without somewhere to put the dimension.
     */
    tags: {
      order: 9,
      fillable: true,
      validation: { rule: schema.string().max(1000) },
      factory: () => null,
    },

    /**
     * The repository this belongs to, copied from the test run it belongs to.
     *
     * Denormalized, and the duplication is the point: this is the column a
     * sharded keyspace routes on, and Vitess cannot follow a foreign key to
     * find it - least of all through two of them, which is the shape here. A
     * grandchild left without it lands in the unsharded keyspace, and every
     * transaction touching it and its parent crosses keyspaces.
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
