import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * The queue's circuit breaker, one row per queue.
 *
 * `@stacksjs/queue` counts successes and failures in a rolling window and pauses
 * a queue that is failing consistently, so a broken downstream - an SMTP server
 * refusing every connection, a webhook endpoint returning 500 - burns one
 * attempt a minute instead of every job in the backlog and all of their retries.
 *
 * The framework reads this table and, when it is absent, prints
 * `queue_circuit_state table missing - circuit breaker disabled. Run migrations
 * to enable.` and carries on. Degrading rather than failing is the right choice
 * there, and it also means the protection is off in every application that
 * never noticed the line: nothing creates this table, in the framework or
 * anywhere else, so "run migrations" has nothing to run.
 *
 * Modelled here rather than hand-written as SQL so `migrate:regenerate` keeps
 * it - see `tests/unit/migrations-from-models.test.ts` for why a hand-written
 * migration is a rule the models do not know about.
 *
 * The column types are the ones the queue writes: counters as integers,
 * `window_start` as a `YYYY-MM-DD HH:MM:SS` string, and both timestamps null
 * while the circuit is closed. Getting one wrong repeats the `reserved_at`
 * failure this application already had - a `date` column the queue filled with
 * a unix timestamp, which made every reservation sweep throw.
 */
export default defineModel({
  name: 'QueueCircuitState',
  table: 'queue_circuit_state',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // Every read is by queue name, and there is exactly one row per queue.
    // Unique rather than plain: two rows would mean two opinions about whether
    // a queue is paused, and the one that loses is silently ignored.
    { name: 'queue_circuit_state_queue_index', columns: ['queue_name'], unique: true },
  ],

  traits: {
    useTimestamps: true,
  },

  attributes: {
    queue_name: {
      order: 1,
      fillable: true,
      validation: { rule: schema.string().required().max(255) },
      factory: () => 'default',
    },

    success_count: {
      order: 2,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    failure_count: {
      order: 3,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    /** When the current counting window opened. `YYYY-MM-DD HH:MM:SS`. */
    window_start: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(32) },
      factory: () => new Date().toISOString().slice(0, 19).replace('T', ' '),
    },

    /** Set while the circuit is open. Null is the ordinary state. */
    paused_at: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(32) },
      factory: () => null,
    },

    /** When it will be tried again. Null while nothing is paused. */
    resume_at: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(32) },
      factory: () => null,
    },
  },
} as const)
