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
    // The read: everything after the cursor a reader holds, within one attempt.
    { name: 'workflow_job_logs_job_index', columns: ['workflow_job_id', 'attempt', 'sequence'] },
    /*
     * The append: a repeat of a chunk already stored is refused by the index
     * rather than by a check somebody has to remember to write.
     *
     * Keyed on the attempt as well, because sequence numbers restart with each
     * one - without it, the first chunk of a re-run collides with the first
     * chunk of the attempt it is meant to be compared against, and is silently
     * dropped as a duplicate.
     */
    { name: 'workflow_job_logs_sequence_index', columns: ['workflow_job_id', 'attempt', 'sequence'], unique: true },
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
    /**
     * Which attempt of the job wrote this.
     *
     * Kept so a re-run does not erase the log of the run that was failing -
     * which is the log somebody re-ran the job to compare against. Defaults to
     * 1, so every line written before this column existed reads as the first
     * attempt, which it was.
     */
    attempt: {
      order: 2,
      fillable: true,
      default: 1,
      validation: { rule: schema.number() },
      factory: () => 1,
    },

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

    /**
     * The same output as events, when the runner sent it that way.
     *
     * Beside `content` rather than instead of it, and that is the whole design:
     * everything that reads a log as text - the API's plain answer, the ceiling
     * arithmetic, somebody with `curl` - keeps working without knowing this
     * column exists, and the screen that can do more reads this one.
     *
     * Four things cannot be recovered from text afterwards and are guesses if
     * you try: which lines a job grouped, when it printed them, which stream
     * each came from, and where its colour started and stopped. `::group::` is
     * a marker one CI product uses and a string somebody's build may legitimately
     * print, so parsing it back out is wrong exactly when the output is
     * interesting.
     *
     * JSON as text, not a JSON column: this is written once and read whole, so
     * the query surface a JSON column buys would be paying for nothing.
     */
    events: {
      order: 5,
      fillable: true,
      // `max` is what decides the column type, not just the validation: a bare
      // `schema.string()` becomes `varchar(255)`, which holds about two events
      // and truncates the rest of a chunk without saying so.
      validation: { rule: schema.string().max(65_535) },
      factory: () => null,
    },
  },
})
