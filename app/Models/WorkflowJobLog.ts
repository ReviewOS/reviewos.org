import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A slice of a job's output, as the runner sent it.
 *
 * Chunks rather than one growing column, because a log is written many times
 * and read from wherever the reader got to. Rewriting a megabyte to append a
 * line is the shape that makes a busy instance slow in a way nobody attributes
 * to logging.
 *
 * **The sequence is the runner's**, and it is what makes an append idempotent.
 * Delivery is at-least-once: a runner that did not hear the answer sends the
 * same chunk again, and without a number to recognise it by the log grows a
 * duplicate copy of whatever the network happened to drop an acknowledgement
 * for. The unique index refuses the second one.
 *
 * Everything in `content` is attacker-controlled text. It is stored as sent,
 * bounded, and escaped where it is rendered - never interpreted here.
 */
export default defineModel({
  name: 'WorkflowJobLog',
  table: 'workflow_job_logs',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // The read: everything after the cursor a reader holds.
    { name: 'workflow_job_logs_job_index', columns: ['workflow_job_id', 'sequence'] },
    // The append: a repeat of a chunk already stored is refused by the index
    // rather than by a check somebody has to remember to write.
    { name: 'workflow_job_logs_sequence_index', columns: ['workflow_job_id', 'sequence'], unique: true },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  belongsTo: [{ model: 'WorkflowJob', onDelete: 'cascade' }],

  attributes: {
    workflow_job_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** The runner's own counter, from 1. */
    sequence: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    /**
     * The bytes, as text.
     *
     * Capped per chunk as well as per job: a single append is not allowed to be
     * the whole ceiling, or one request decides what the rest of the run may
     * say.
     */
    content: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().max(65_535) },
      factory: () => '',
    },

    /**
     * Which stream it came from.
     *
     * Kept apart because a reader looking for why something failed is usually
     * looking for stderr, and merging them makes that a search rather than a
     * filter. Interleaving is preserved by the sequence regardless.
     */
    stream: {
      order: 4,
      fillable: true,
      default: 'stdout',
      validation: { rule: schema.enum(['stdout', 'stderr']) },
      factory: () => 'stdout',
    },
  },
})
