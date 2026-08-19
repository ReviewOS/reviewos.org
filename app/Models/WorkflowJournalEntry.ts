import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One `step()` call, written down before the work is dispatched.
 *
 * **The journal, not the orchestrator's memory, is the run.** That sentence is
 * the whole of durable execution and everything else here follows from it: a
 * workflow program is a job like any other, it can be killed at any instant,
 * and what survives is this table. On restart the program runs again from its
 * first line - and every call it makes that is already here returns the
 * recorded answer instead of doing the work a second time.
 *
 * ## Written before, resolved after
 *
 * A row is inserted when the call is *made*, with `state: 'pending'`, and
 * updated when the work finishes. The order is the point. Recording afterwards
 * would leave a window where a step ran and nothing knows it did - kill the
 * orchestrator there and the replay dispatches it again, which for a step that
 * charged a card or cut a release is not a retry, it is a second one.
 *
 * ## What makes a call the same call
 *
 * `sequence` is the position: the first `step()` a program makes is 1, the
 * second is 2, whatever they are called. That is what a deterministic program
 * guarantees and it is why determinism is enforced rather than requested.
 * `identity` is what the call *was* - its name and a digest of its arguments -
 * and it is compared on replay. Matching sequence with a different identity is
 * a **divergence**: the program did something different this time, so its
 * recorded results describe a run that no longer exists.
 *
 * Divergence fails the run loudly and names what changed. Silent divergence is
 * the failure mode of every durable execution system, and this repository has a
 * written history of exactly that shape of bug going unnoticed for months.
 */
export default defineModel({
  name: 'WorkflowJournalEntry',
  table: 'workflow_journal_entries',
  primaryKey: 'id',
  autoIncrement: true,

  belongsTo: [{ model: 'WorkflowRun', onDelete: 'cascade' }],

  indexes: [
    /*
     * The linearization point, and the reason this needs no lock.
     *
     * Whoever wins this insert owns the right to dispatch that call. Two
     * orchestrators for one run - which happens when a lease lapses and the
     * scheduler hands the work to a second machine while the first is still
     * alive - both try, one loses, and the loser is told it lost rather than
     * quietly running everything twice.
     */
    { name: 'workflow_journal_entries_sequence_index', columns: ['workflow_run_id', 'sequence'], unique: true },
    // The replay read: one run's journal in order, in one indexed scan.
    { name: 'workflow_journal_entries_run_index', columns: ['workflow_run_id'] },
  ],

  traits: { useTimestamps: true, useSeeder: { count: 0 } },

  attributes: {
    workflow_run_id: {
      order: 1,
      fillable: true,
      required: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    /**
     * Which call this was, counting from 1.
     *
     * The position rather than a name, because two calls to `step('test')` in a
     * loop are two different calls and naming cannot tell them apart. A
     * deterministic program produces the same sequence every time, which is
     * exactly what the determinism rules exist to guarantee.
     */
    sequence: {
      order: 2,
      fillable: true,
      required: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    /**
     * What the call was: `step`, `sleep`, `now`, `random`, `waitForEvent`.
     *
     * The injected ones are journaled for the same reason the steps are. A
     * program that reads the clock directly sees a different value on replay
     * and takes a different branch, which is divergence with no way to detect
     * it - so the clock is a journaled call and replay hands back the value it
     * saw the first time.
     */
    kind: {
      order: 3,
      fillable: true,
      required: true,
      default: 'step',
      validation: { rule: schema.string().max(30).required() },
      factory: () => 'step',
    },

    /**
     * The call's name and arguments, digested.
     *
     * Compared on replay. A digest rather than the arguments themselves
     * because arguments can be large and because this is only ever asked one
     * question - "is this the same call" - which a hash answers.
     */
    identity: {
      order: 4,
      fillable: true,
      required: true,
      validation: { rule: schema.string().max(64).required() },
      factory: () => 'a'.repeat(64),
    },

    /** The name as written, so a divergence can say what changed rather than that something did. */
    name: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(200) },
      factory: () => 'build',
    },

    /** `pending`, `done`, or `failed`. */
    state: {
      order: 6,
      fillable: true,
      required: true,
      default: 'pending',
      validation: { rule: schema.string().max(20).required() },
      factory: () => 'pending',
    },

    /**
     * What the call returned, as JSON.
     *
     * The typed result a replay hands back, and the reason a later step reading
     * an earlier one's output is reading the database rather than scraping a
     * log. Bounded by the journal-size budget rather than by this column, so
     * that a workflow returning something enormous is stopped with a reason
     * instead of silently truncated into a value that is not what it returned.
     */
    result: {
      order: 7,
      fillable: true,
      validation: { rule: schema.text() },
      factory: () => null,
    },

    /** Why it failed, when it did. */
    error: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string().max(2000) },
      factory: () => null,
    },

    /** The job this call became, when the call dispatched real work. */
    workflow_job_id: {
      order: 9,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /**
     * When a suspended call may be resumed.
     *
     * A `sleep` writes this and the orchestrator's runner is released - a
     * workflow waiting three days for an approval must not hold a lease for
     * three days. The sweep that wakes it reads this column.
     */
    wake_at: {
      order: 10,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },

    /** How long the call took, once it was done. */
    duration_ms: {
      order: 11,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /**
     * The repository this belongs to, copied from its run.
     *
     * Denormalized on purpose: this is the column a sharded keyspace routes on,
     * and Vitess cannot follow a foreign key to find it.
     */
    repository_id: {
      order: 90,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
})
