import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * An autoscaled runner group whose launches keep ending without a runner.
 *
 * Whether a group is backing off is not stored here: the scaler works that out
 * every minute from the group's own launch record in AWS, so a restart loses
 * nothing (`planLaunchBackoff` in ts-cloud). What is stored is the one thing
 * that record cannot say - **whether somebody has been told**. On 2026-11-13
 * HQ's group launched an instance a minute for twenty-one hours, every one of
 * them dead at boot, and the only trace was a log line. An alert that is sent
 * from a process's memory is sent again after every deploy, or never after
 * the first; a row is how it is sent once when the trouble starts and once
 * when it ends.
 *
 * ## One row per group, kept
 *
 * `recovered_at` empty means the incident is open and has been announced. A
 * group that recovers keeps its row, with `recovered_at` set, and the next
 * incident reuses it - so the row is also the answer to "when did this last
 * happen". `/api/metrics` reads it for the group's gauges, because the web
 * process answering a scrape is not the scheduler that ran the tick.
 */
export default defineModel({
  name: 'RunnerGroupBackoff',
  table: 'runner_group_backoffs',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // One row per group, by the database's word rather than the scaler's:
    // two rows would be two opinions about whether the alert went out.
    { name: 'runner_group_backoffs_group_name_unique', columns: ['group_name'], unique: true },
  ],

  traits: {
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  attributes: {
    /** The Auto Scaling group's name, as `cloud/autoscaling.ts` declares it. */
    group_name: {
      order: 1,
      fillable: true,
      validation: { rule: schema.string().required().max(255) },
      factory: () => 'reviewos-runner-hq',
    },

    /** How many launches in a row ended without a runner, at the last tick that looked. */
    died: {
      order: 2,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    /** When the oldest launch of that run started, in UTC. */
    since: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().max(32) },
      factory: () => null,
    },

    /** The newest instance that died: the one whose console output is still there to read. */
    example: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(64) },
      factory: () => null,
    },

    /** When the next probe may launch. Empty once the group has recovered. */
    next_probe_at: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(32) },
      factory: () => null,
    },

    /** When the operators were told. Set in the same write that opens the incident. */
    alerted_at: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(32) },
      factory: () => null,
    },

    /** When a launch registered again. Empty while the incident is open. */
    recovered_at: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().max(32) },
      factory: () => null,
    },
  },
} as const)
