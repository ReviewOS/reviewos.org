import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A job that ran out of attempts.
 *
 * **This table did not exist**, and `config/queue.ts` has named
 * `QUEUE_FAILED_DRIVER=database` with `table: 'failed_jobs'` the whole time. So
 * a job that exhausted its retries was written to a table that was not there:
 * the write failed, the row went nowhere, and the failure left no trace beyond
 * a line in a log nobody was tailing.
 *
 * That is the worst shape a queue failure can take. A notification that never
 * arrives, a webhook that never fires, a mirror that never syncs - none of them
 * report anything, and the person waiting concludes the feature is slow rather
 * than broken. The whole point of a dead-letter table is that the failure is a
 * *row* somebody can find, count, read the exception from, and retry.
 *
 * Adopted from the framework's default rather than invented, so the columns are
 * the ones `@stacksjs/queue` already writes and reads. The app-level copy
 * exists for one reason: `buddy generate:migrations` builds from the models
 * this application declares, and a framework default it never sees produces no
 * migration.
 */
export default defineModel({
  name: 'FailedJob',
  table: 'failed_jobs',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // The two questions an operator asks: what has failed lately, and what has
    // failed on this queue.
    { name: 'failed_jobs_queue_index', columns: ['queue', 'failed_at'] },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  attributes: {
    connection: {
      order: 1,
      fillable: true,
      validation: { rule: schema.string().max(100) },
      factory: () => 'database',
    },

    queue: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().max(100) },
      factory: () => 'default',
    },

    /**
     * The job as it was dispatched, so a retry re-runs the same work.
     *
     * The whole envelope, not a summary. A retry that reconstructed the payload
     * from a description would run something adjacent to what failed, which is
     * worse than not retrying - the operator believes the original work has
     * been done.
     */
    payload: {
      order: 3,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: () => '{}',
    },

    /**
     * Why it stopped, as the worker saw it.
     *
     * Kept in full, including the stack. This is read exactly once, by somebody
     * who has just discovered that a thing did not happen, and a truncated
     * exception at that moment is a second investigation.
     */
    exception: {
      order: 4,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: () => null,
    },

    failed_at: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },
  },
} as const)
