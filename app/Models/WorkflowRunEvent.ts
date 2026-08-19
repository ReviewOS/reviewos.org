import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Something the world told a run.
 *
 * A run can hold still until it is told - a deployment that finished elsewhere,
 * an approval collected in another system, a soak somebody ended early - and
 * this is the telling. One row per event received, whether or not anything was
 * waiting for it.
 *
 * ## Recorded even when nothing was waiting
 *
 * That is the useful half. An event that arrives a second before the job that
 * waits for it becomes eligible would otherwise vanish, and the run would sit
 * until its timeout on a message that *did* arrive - the classic lost-wakeup,
 * and the hardest kind of report to believe. The row is here, so the wait
 * checks the record when it starts as well as being woken by it.
 *
 * ## Why the key is unique
 *
 * A sender that does not hear the answer sends again; that is what every
 * webhook in the world does. Without a key those are two events, and a run
 * waiting for `deploy-finished` twice in a loop would be let through twice on
 * one deployment. With it the second delivery finds the first row and is told
 * so, which is the same answer it would have got had it heard the first time.
 *
 * A sender that names no key gets one derived from the delivery, so the column
 * is never null and the index is never partly enforced.
 */
export default defineModel({
  name: 'WorkflowRunEvent',
  table: 'workflow_run_events',
  primaryKey: 'id',
  autoIncrement: true,

  belongsTo: [{ model: 'WorkflowRun', onDelete: 'cascade' }],

  indexes: [
    /*
     * The idempotency point. Whoever wins this insert delivered the event; a
     * second sender with the same key loses and is told it was already
     * recorded, rather than waking a run twice on one thing that happened once.
     */
    { name: 'workflow_run_events_key_index', columns: ['idempotency_key'], unique: true },
    // The lost-wakeup read: has anything already sent this run this event.
    { name: 'workflow_run_events_run_index', columns: ['workflow_run_id', 'name'] },
    { name: 'workflow_run_events_repository_index', columns: ['repository_id'] },
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
     * What happened, as the workflow file names it.
     *
     * Typed in the sense that matters here: a run waits for `deploy-finished`
     * and is not woken by `deploy-started`. Matched exactly, because a wait
     * that woke on a prefix would be a wait somebody has to reason about.
     */
    name: {
      order: 2,
      fillable: true,
      required: true,
      validation: { rule: schema.string().max(200).required() },
      factory: () => 'deploy-finished',
    },

    /**
     * What came with it, as JSON.
     *
     * Becomes the waiting job's outputs, so a later job reads it as
     * `needs.approval.outputs.version` - the same way it reads any other job's.
     * Inventing a second mechanism for "values that came from outside" would be
     * a second thing to learn for a value that behaves identically.
     *
     * Bounded where it is written, like every other value a stranger supplies.
     */
    payload: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().max(20_000) },
      factory: () => null,
    },

    /**
     * The key that makes a repeat a repeat.
     *
     * Never null: a sender that names none gets one derived from what it sent,
     * because a unique index over a nullable column enforces nothing for
     * exactly the callers least likely to be careful.
     */
    idempotency_key: {
      order: 4,
      fillable: true,
      required: true,
      validation: { rule: schema.string().max(200).required() },
      factory: () => 'a'.repeat(20),
    },

    /**
     * Who sent it, when it was somebody with an account here.
     *
     * Null for a machine holding a token that belongs to no person, which is
     * most of them - `source` is what carries the answer in that case.
     */
    actor_id: {
      order: 5,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** What kind of caller it was: `api`, `interface`, or `runner`. */
    source: {
      order: 6,
      fillable: true,
      default: 'api',
      validation: { rule: schema.string().max(30) },
      factory: () => 'api',
    },

    /** How many waiting jobs this event ended, for the answer the sender gets. */
    delivered_to: {
      order: 7,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    /**
     * The repository this belongs to, copied from its run.
     *
     * Denormalized, and the duplication is the point: this is the column a
     * sharded keyspace routes on, and Vitess cannot follow a foreign key to
     * find it. A child left without it lands in the unsharded keyspace, and
     * every transaction touching it and its parent crosses keyspaces.
     */
    repository_id: {
      order: 90,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
})
