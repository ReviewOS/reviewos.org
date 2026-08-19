import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One thing that happened to a deployment, in order.
 *
 * The deployment row carries where it got to; this carries how it got there. A
 * column holding the current state answers "is production up" and cannot answer
 * "when did it go down and what did the job say" - and the second is the
 * question somebody asks at the point where it matters, which is always after
 * the fact.
 *
 * ## Why a row rather than a wider deployment
 *
 * The same argument as `workflow_step_attempts` next door: a deployment that
 * went `in_progress` → `failed` → `in_progress` → `active` is four facts, and a
 * row that overwrites itself keeps one of them. A rollback in particular is
 * unreadable without this - "what was restored, and from what" is a question
 * about two states, and a single column has only ever seen the latest.
 *
 * ## What a status is allowed to say
 *
 * Whatever the deployment's own state can say, plus the words for the two edges
 * a state cannot express: `queued` for a deployment recorded before its job
 * starts, and `rolled_back` for one deliberately replaced by an earlier
 * version. They are statuses rather than deployment states on purpose - a
 * rolled-back deployment *is* inactive, and a listing that had to know about a
 * fifth state to render a badge would be one more thing to keep in step.
 */
export default defineModel({
  name: 'DeploymentStatus',
  table: 'deployment_statuses',
  primaryKey: 'id',
  autoIncrement: true,

  belongsTo: [{ model: 'Deployment', onDelete: 'cascade' }],

  indexes: [
    // The read: one deployment's history in order, in one indexed scan.
    { name: 'deployment_statuses_deployment_index', columns: ['deployment_id', 'id'] },
    { name: 'deployment_statuses_repository_index', columns: ['repository_id'] },
  ],

  traits: { useTimestamps: true, useSeeder: { count: 0 } },

  attributes: {
    deployment_id: {
      order: 1,
      fillable: true,
      required: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    state: {
      order: 2,
      fillable: true,
      required: true,
      default: 'queued',
      validation: {
        rule: schema.enum(['queued', 'in_progress', 'active', 'failed', 'inactive', 'rolled_back']),
      },
      factory: () => 'queued',
    },

    /**
     * What the job said about it, in one line.
     *
     * Untrusted text like everything else a job reports, and bounded for the
     * same reason: this is read on a screen beside the others, and one status
     * carrying a stack trace would push every other line off it.
     */
    description: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().max(1000) },
      factory: () => null,
    },

    /**
     * Where it went, when this status is the one that changed it.
     *
     * A deployment's URL can move between statuses - a preview that is rebuilt
     * lands somewhere new - and the deployment row carries the current one. This
     * carries the one that was true at this point, so a history that says "it
     * was here on Tuesday" is answering from a record rather than from an
     * inference.
     */
    url: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    /**
     * The deployment this one replaced, when it is a rollback.
     *
     * Null on every other status. It is what makes "rollback records the
     * version restored" a fact on the row rather than a sentence somebody wrote
     * into a description and hoped to parse later.
     */
    restored_deployment_id: {
      order: 5,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** Who or what said it. Null for a job with no person behind it. */
    actor_id: {
      order: 6,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /**
     * The repository this belongs to, copied from its deployment.
     *
     * Denormalized, and the duplication is the point: this is the column a
     * sharded keyspace routes on, and Vitess cannot follow a foreign key to
     * find it. A child left without it lands in the unsharded keyspace, and
     * every transaction touching it and its parent crosses keyspaces.
     */
    repository_id: {
      order: 90,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },
  },
})
