import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Who is told when a run ends, and under what conditions.
 *
 * A rule rather than a switch, and the difference is the feature. "Notify me
 * about this repository" is an inbox nobody reads by the second week: a
 * repository that runs twelve workflows on every push produces twelve
 * notifications about things that were always going to pass. The rules people
 * actually want are narrow - *tell me when the deploy workflow fails on main*,
 * *tell me when the nightly goes green again* - and each of those is a sentence
 * this row can hold.
 *
 * **It names somebody on this instance, never an address.** A rule that took an
 * email address would make every repository here a mail relay, and the channel
 * is the recipient's own decision: phase 5 already knows whether they want an
 * email, a push, or only the inbox.
 */
export default defineModel({
  name: 'WorkflowNotificationRule',
  table: 'workflow_notification_rules',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'workflow_notification_rules_repository_index', columns: ['repository_id'] },
    /*
     * One rule per person per shape. Without it, a form submitted twice is two
     * rows and two notifications about one run - which reads as the feature
     * being broken rather than as a duplicate.
     */
    { name: 'workflow_notification_rules_unique', columns: ['repository_id', 'user_id', 'workflow', 'branch', 'job_key', 'condition'], unique: true },
  ],

  traits: { useUuid: true, useTimestamps: true, useSeeder: { count: 0 } },

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      required: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    /** Who is told. Somebody on this instance, whose own settings decide the channel. */
    user_id: {
      order: 2,
      fillable: true,
      required: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    /**
     * Which workflow, by path or name, or `*` for every one.
     *
     * A glob rather than an id, because a rule should survive a workflow file
     * being renamed in the way people rename them - `deploy.yml` moving from
     * `.github` to `.reviewos` is the same workflow to everybody but a foreign
     * key.
     */
    workflow: {
      order: 3,
      fillable: true,
      default: '*',
      validation: { rule: schema.string().max(200) },
      factory: () => '*',
    },

    /** Which branch, as a glob: `main`, `release/*`, or `*`. */
    branch: {
      order: 4,
      fillable: true,
      default: '*',
      validation: { rule: schema.string().max(200) },
      factory: () => '*',
    },

    /**
     * One job, or empty for the run as a whole.
     *
     * The per-step half of the box this implements: a nightly with forty green
     * jobs and one red deploy is a notification nobody reads unless it names
     * the job, and the person who cares about the deploy is usually not the
     * person who cares about the run.
     */
    job_key: {
      order: 5,
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(200) },
      factory: () => '',
    },

    /**
     * When to tell them.
     *
     * `recovery` is the one that is not obvious and is the most used in
     * practice: the first success after a failure. A team that wants "tell me
     * when it breaks" almost always also wants "and tell me when it is fixed",
     * and without this they get that by subscribing to every success.
     */
    condition: {
      order: 6,
      fillable: true,
      default: 'failure',
      validation: { rule: schema.enum(['failure', 'success', 'recovery', 'always']) },
      factory: () => 'failure',
    },

    /** Who added it, for a repository administrator reading the list. */
    created_by_id: {
      order: 7,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
} as const)
