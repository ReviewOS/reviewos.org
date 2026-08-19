import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One test, followed across runs.
 *
 * **Identity is suite, scope and name**, and the scope is what makes it work:
 * two tests called `renders` in different files are two tests, and a tool that
 * keys on the name alone reports one flaky test that is actually two healthy
 * ones. Scope is the file or class the reporter gives, because that is what
 * every test format actually carries.
 *
 * A rename makes a new row, and that is the honest answer rather than a
 * heuristic: guessing that `renders the header` and `renders a header` are the
 * same test is guessing about somebody's intent, and being wrong loses the
 * history of the test that still exists.
 */
export default defineModel({
  name: 'ManagedTest',
  table: 'managed_tests',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'managed_tests_repository_index', columns: ['repository_id'] },
    { name: 'managed_tests_identity_index', columns: ['test_suite_id', 'scope', 'name'], unique: true },
    { name: 'managed_tests_state_index', columns: ['test_suite_id', 'state'] },
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

    /** The file or class the reporter gave. Empty when it gave none. */
    scope: {
      order: 2,
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(500) },
      factory: () => '',
    },

    name: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required().max(500) },
      factory: () => 'a test',
    },

    /**
     * `enabled`, `muted`, or `skipped` - three states most tools conflate into
     * two, at the cost of the distinction that matters.
     *
     * A **muted** test still runs and still reports; its failures simply do not
     * fail the run. That keeps the signal: somebody can see it is still broken,
     * and the day it starts passing again is visible. A **skipped** test does
     * not run at all, so nobody learns anything about it - which is sometimes
     * right and is never the same thing.
     */
    state: {
      order: 4,
      fillable: true,
      default: 'enabled',
      validation: { rule: schema.enum(['enabled', 'muted', 'skipped']) },
      factory: () => 'enabled',
    },

    /*
     * Quarantine, auditable and expiring. Every field here exists because a
     * mute with none of them becomes permanent: nobody remembers who did it,
     * why, or whether the reason still holds, and the suite quietly stops
     * testing what it says it tests.
     */
    muted_by_id: {
      order: 5,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    muted_at: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    muted_reason: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().max(1000) },
      factory: () => null,
    },

    /** When somebody promised to look at it again. */
    review_at: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    /**
     * Who this test belongs to, so a failure has an addressee.
     *
     * A path or a team name, whichever the repository maps. A flaky test with
     * nobody's name on it is one that stays flaky.
     */
    owner: {
      order: 9,
      fillable: true,
      validation: { rule: schema.string().max(200) },
      factory: () => null,
    },

    /** Whether the last flake pass found it changing its mind. */
    flaky: {
      order: 10,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /** Why it was called flaky, in words, for the screen that shows it. */
    flaky_reason: {
      order: 11,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    /**
     * When it first started being called flaky, and not rewritten after.
     *
     * The boolean says what is true now; this says since when, which is the
     * only way to ask whether a failure was caused by a test we *already* knew
     * about. Without it, every improvement to flake detection retroactively
     * blames past runs on tests nobody could have fixed yet, and the cost of
     * flakiness appears to rise every time we get better at spotting it.
     */
    flaky_since: {
      order: 12,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

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
