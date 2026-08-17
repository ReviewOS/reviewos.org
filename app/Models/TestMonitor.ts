import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A rule that watches a suite over time and says something once when it stops
 * being true.
 *
 * **The state lives here, and that is the whole design.** A rule evaluated
 * hourly against "is the failure rate above 5%" is true every hour it is true,
 * and a rule that acted on the answer would send the same alarm twenty-four
 * times a day - which is how a channel becomes one people mute, and the muted
 * channel is the one that has to work when it matters.
 *
 * So the monitor remembers whether it was in alarm, and only the *transition*
 * is an event: `ok` to `alarm` when the condition starts holding, `alarm` to
 * `ok` when it stops. The recovery is not a courtesy either - somebody who was
 * told a suite is unreliable has no way to learn it is fine again, and a
 * dashboard that only ever goes red is a dashboard people learn to ignore.
 */
export default defineModel({
  name: 'TestMonitor',
  table: 'test_monitors',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'test_monitors_repository_index', columns: ['repository_id', 'enabled'] },
  ],

  traits: { useUuid: true, useTimestamps: true, useSeeder: { count: 0 } },

  belongsTo: [{ model: 'Repository', onDelete: 'cascade' }],

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** The suite this watches. Empty watches every suite together. */
    suite: {
      order: 2,
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(200) },
      factory: () => '',
    },

    /**
     * What it watches.
     *
     * Three, deliberately, and each is a question somebody actually asks:
     * `flaky` counts tests that disagree with themselves, `fail_rate` is the
     * share of executions that failed, and `duration` is what one run of the
     * suite costs. A general expression language here would be a second
     * product to document, test and get wrong.
     */
    condition: {
      order: 3,
      fillable: true,
      default: 'fail_rate',
      validation: { rule: schema.enum(['flaky', 'fail_rate', 'duration']) },
      factory: () => 'fail_rate',
    },

    /**
     * The line it must cross: a count of tests for `flaky`, a **percentage**
     * for `fail_rate`, milliseconds for `duration`.
     *
     * Percent rather than a share from zero to one, and that is a decision
     * about the trap rather than about taste: somebody typing `5` at a field
     * that wants a share has written five hundred percent, and the monitor
     * they made can never fire - which reads as covered. In percent, `5` means
     * what they meant.
     *
     * Exact decimal, not a float. `2.5` matters here and a four-byte float
     * hands `0.05` back as `0.05000000074505806`, which is a threshold
     * somebody tries to correct and cannot.
     */
    threshold: {
      order: 4,
      fillable: true,
      default: 0,
      validation: { rule: schema.decimal() },
      factory: () => 0,
    },

    /** How much history each evaluation reads, in days. */
    window_days: {
      order: 5,
      fillable: true,
      default: 7,
      validation: { rule: schema.number() },
      factory: () => 7,
    },

    /** `ok` or `alarm`. The reason one alarm is one message rather than one an hour. */
    state: {
      order: 6,
      fillable: true,
      default: 'ok',
      validation: { rule: schema.enum(['ok', 'alarm']) },
      factory: () => 'ok',
    },

    /** What the last evaluation measured, so a page can show the number behind the state. */
    measurement: {
      order: 7,
      fillable: true,
      default: 0,
      validation: { rule: schema.decimal() },
      factory: () => 0,
    },

    /** When it last changed state - not when it was last evaluated. */
    changed_at: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },

    /** When it was last looked at, which is how somebody knows the rule is running. */
    evaluated_at: {
      order: 9,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },

    /**
     * Off without being deleted.
     *
     * A monitor somebody turned off is a decision, and deleting it loses both
     * the threshold they picked and the fact that they once cared.
     */
    enabled: {
      order: 10,
      fillable: true,
      default: true,
      validation: { rule: schema.boolean() },
      factory: () => true,
    },
  },
})
