import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One pull request waiting to land, in the order it will land.
 *
 * A merge queue exists because "green on my branch" and "green after
 * everything ahead of me lands" are different questions, and only the second
 * one matters. Two pull requests that each pass alone and break together are
 * the ordinary case, not the exotic one - a renamed function and a new caller
 * of it will do it.
 *
 * So an entry is tested against the **prospective merge result**: the base
 * branch with everything ahead of it in the queue already merged, plus this
 * one. That is the commit that will exist if it lands, and testing anything
 * else is testing a commit nobody will ever have.
 */
export default defineModel({
  name: 'MergeQueueEntry',
  table: 'merge_queue_entries',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    { name: 'merge_queue_entries_branch_index', columns: ['repository_id', 'base_branch', 'state'] },
    { name: 'merge_queue_entries_pull_unique', columns: ['pull_request_id'], unique: true },
  ],

  traits: { useUuid: true, useTimestamps: true, useSeeder: { count: 0 } },

  belongsTo: [{ model: 'Repository', onDelete: 'cascade' }, { model: 'PullRequest', onDelete: 'cascade' }],

  attributes: {
    repository_id: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    pull_request_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => null,
    },

    /** The branch this is landing on. One queue per branch, not per repository. */
    base_branch: {
      order: 3,
      fillable: true,
      default: 'main',
      validation: { rule: schema.string().max(255) },
      factory: () => 'main',
    },

    /**
     * `queued`, `testing`, `merged`, `ejected`.
     *
     * `ejected` rather than `failed`, because the pull request has not failed -
     * it did not land *this time*, in this order, and saying so is the
     * difference between a queue people trust and one they route around.
     */
    state: {
      order: 4,
      fillable: true,
      default: 'queued',
      validation: { rule: schema.enum(['queued', 'testing', 'merged', 'ejected']) },
      factory: () => 'queued',
    },

    /** Position in the queue. Lower lands first. */
    position: {
      order: 5,
      fillable: true,
      default: 0,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    /**
     * The prospective merge commit this entry is being tested on.
     *
     * Written when the entry starts testing and kept afterwards: a run points
     * at a commit, and an entry that landed should be able to say which commit
     * was actually green.
     */
    merge_sha: {
      order: 6,
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(64) },
      factory: () => '',
    },

    /** The run testing it, so a screen can link to what is deciding. */
    workflow_run_id: {
      order: 7,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** Why it was ejected, in words, for the person whose change it was. */
    reason: {
      order: 8,
      fillable: true,
      default: '',
      validation: { rule: schema.string().max(1000) },
      factory: () => '',
    },
  },
})
