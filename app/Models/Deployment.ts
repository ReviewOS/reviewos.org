import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Something that was put somewhere: an environment, a commit, and a URL.
 *
 * Phase 9 asks for one deployment model rather than one per feature, and this
 * is it. A preview for a pull request and a production release are the same
 * row with different environments - which is the point: "what is on staging"
 * and "what is on this pull request's preview" are the same question, and a
 * product that answers them from two tables answers them differently within a
 * month.
 *
 * **A deployment is recorded, never performed.** This instance does not push to
 * anybody's infrastructure: a job does that, with credentials the environment
 * released to it, and then says what happened here. So the row is provenance -
 * which run, which commit, which environment, what URL came out - and the
 * history is what somebody reads when a page is wrong and nobody remembers what
 * was deployed on Friday.
 */
export default defineModel({
  name: 'Deployment',
  table: 'deployments',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'deployments_repository_index', columns: ['repository_id', 'environment'] },
    { name: 'deployments_pull_request_index', columns: ['pull_request_id'] },
    { name: 'deployments_state_index', columns: ['state'] },
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

    /** The environment's name, as the workflow wrote it: `production`, `preview-42`. */
    environment: {
      order: 2,
      fillable: true,
      required: true,
      validation: { rule: schema.string().max(120).required() },
      factory: () => 'production',
    },

    /** The commit that was deployed. The one fact a rollback needs. */
    head_sha: {
      order: 3,
      fillable: true,
      required: true,
      validation: { rule: schema.string().max(64).required() },
      factory: () => 'a'.repeat(40),
    },

    /** The ref it came from, for a reader working out what this was. */
    ref: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(255) },
      factory: () => 'refs/heads/main',
    },

    /**
     * The pull request this is a preview of, when it is one.
     *
     * What makes a preview expire without a second concept: the deployment
     * belongs to a pull request, and a pull request that closes takes its
     * previews with it.
     */
    pull_request_id: {
      order: 5,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** The run that made it, so the log is one click from the deployment. */
    workflow_run_id: {
      order: 6,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /**
     * Where it can be seen.
     *
     * The whole value of a preview: a link on the pull request that a reviewer
     * clicks. Empty for a deployment with nothing to look at - a database
     * migration, a firmware push - which is a real case and not an error.
     */
    url: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => '',
    },

    /**
     * `in_progress`, `active`, `failed`, or `inactive`.
     *
     * `inactive` is what expiry means here: the row stays, because "what was on
     * this URL last Tuesday" is a question somebody asks, and deleting the
     * history to express that something is no longer running answers it with
     * silence.
     */
    state: {
      order: 8,
      fillable: true,
      default: 'in_progress',
      validation: { rule: schema.enum(['in_progress', 'active', 'failed', 'inactive']) },
      factory: () => 'in_progress',
    },

    /**
     * The rollout this deployment arrives through, when it arrives in stages.
     *
     * `10,50,100`, or `canary:10, half:50, all:100` when the names are worth
     * having on a screen. Empty for the ordinary case, which is a deployment
     * that is simply live.
     *
     * Stored as written rather than expanded into rows: a plan is a sentence
     * about intent, and a table of stages would be four rows that can disagree
     * with the deployment they belong to.
     */
    stages: {
      order: 12,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    /** Which stage is serving now, counting from zero. */
    stage_index: {
      order: 13,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    /**
     * Whether an operator has stopped this rollout where it is.
     *
     * Beside the stage rather than expressed as a state, because a held rollout
     * is still serving whatever share it reached - "paused" as a deployment
     * state would say nothing is live, which is the opposite of true and the
     * dangerous direction to be wrong in.
     */
    stage_held: {
      order: 14,
      fillable: true,
      default: false,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    /** Why it ended, when something ended it: `the pull request merged`. */
    reason: {
      order: 9,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => '',
    },

    /** Who or what recorded it. Null for a job with no actor behind it. */
    created_by_id: {
      order: 10,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** When it stopped being current, so a listing can say "until Friday". */
    finished_at: {
      order: 11,
      fillable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },
  },
} as const)
