import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * The queue's own table, overriding the framework default.
 *
 * Two columns in `storage/framework/defaults/app/Models/Job.ts` describe
 * something other than what `@stacksjs/queue` actually stores, and both stop
 * the queue rather than degrading it. Overridden here through the `app/`
 * resolution order rather than patched into `node_modules`, so the fix is a
 * file in this repository that survives an install.
 *
 * **`reserved_at` was `schema.date()`, which generates a `date` column.** The
 * queue writes a unix timestamp there and its reservation sweep asks
 * `reserved_at <= $1` with an integer, so Postgres answers `operator does not
 * exist: date <= integer` on every tick. Nothing is ever reserved, so nothing
 * is ever processed - and the failure is a log line inside the worker's loop,
 * not an error anybody dispatching a job would see. A job dispatched to the
 * database driver sits in the table forever while the worker reports
 * "Listening for jobs..." once a second.
 *
 * It is the same kind of value as `available_at`, which is correctly a number
 * in the same file, three lines above.
 *
 * **`payload` had no `max`, which generates `varchar(255)`.** A payload is
 * JSON: the job name, the arguments, and the options. The trivial two-field
 * probe used to find the bug above was already eighty characters. Postgres
 * refuses an over-length varchar rather than truncating it, so this is a
 * dispatch that throws for large payloads and works for small ones, which is
 * the worst version - it passes every test written with a short payload.
 *
 * Both belong upstream in Stacks as well. `node_modules/@stacksjs/*` are
 * published copies in this checkout rather than links to a local core, so the
 * override is what makes the queue work here today.
 *
 * One thing to know when regenerating. `generate:migrations` writes
 * `USING <column>::<newtype>` for every type change without asking whether that
 * pair is castable, and there is no `date` to `integer` cast in Postgres - so
 * the `ALTER` it produced for `reserved_at` could not run at all, and the
 * corpus carries `USING NULL::integer` instead. Discarding is correct rather
 * than lossy: the sweep never worked, so every value in that column is null and
 * always was. On a database built fresh from these models the column is
 * `integer` from the `CREATE` and no `ALTER` exists to correct.
 */
export default defineModel({
  name: 'Job',
  table: 'jobs',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
    useSeeder: {
      count: 15,
    },
  },

  attributes: {
    queue: {
      fillable: true,
      validation: {
        rule: schema.string().required().max(255),
        message: {
          max: 'Queue must have a maximum of 255 characters',
        },
      },
      factory: () => 'default',
    },

    /** JSON: the job name, its arguments, and its options. Not a sentence. */
    payload: {
      fillable: true,
      type: 'text',
      validation: {
        rule: schema.string().required(),
      },
      factory: () => JSON.stringify({ jobName: 'Example', payload: {}, options: {} }),
    },

    attempts: {
      fillable: true,
      validation: {
        rule: schema.number(),
        message: {
          number: 'attempts must be a number',
        },
      },
      factory: faker => faker.number.int({ min: 0, max: 10 }),
    },

    /** When this becomes runnable, as unix seconds. */
    available_at: {
      fillable: true,
      validation: {
        rule: schema.number(),
      },
      factory: faker => faker.number.int({ min: 1000000, max: 1999999 }),
    },

    /**
     * When a worker took it, as unix seconds, or null while it is waiting.
     *
     * A number rather than a date because that is what the queue compares it
     * to. See the note at the top of this file.
     */
    reserved_at: {
      fillable: true,
      validation: {
        rule: schema.number(),
      },
      factory: () => null,
    },
  },
} as const)
