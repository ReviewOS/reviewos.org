import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One long-running thing somebody asked for.
 *
 * The problem this exists to remove: an endpoint that starts work and answers
 * `202 Accepted` has told the caller nothing they can act on. Did it start? Is
 * it still going? Did it fail an hour ago? The usual answer is "poll the
 * resource and infer", which means every client writes a different inference
 * and each one is wrong in a different way - a mirror that has not moved is
 * indistinguishable from a sync that never ran.
 *
 * So an operation is a *resource*. It has an id, a status, a URL, and a shape
 * that does not depend on what kind of work it is. A client that can follow one
 * can follow all of them, which is the entire point of a pattern.
 *
 * ## The states, and why these five
 *
 * `queued` and `running` are different facts, and conflating them hides the
 * failure mode worth seeing: work that is accepted and never picked up. A
 * client watching something sit in `queued` knows to look at the workers; one
 * watching `running` knows to wait.
 *
 * `succeeded`, `failed` and `cancelled` are the three ways to stop. Cancelled is
 * separate from failed because a caller that asked to stop should not be told
 * their work broke, and an operator reading a list of failures should not be
 * counting the deliberate ones.
 *
 * ## Kept, not swept
 *
 * A finished operation stays. Its whole value is answering "what happened" to
 * somebody who asked after the fact, and a row deleted an hour later answers
 * that with a 404 that reads as "no such operation" rather than "it finished".
 */
export default defineModel({
  name: 'Operation',
  table: 'operations',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // The two questions: what is happening to this repository, and what has
    // this token started.
    { name: 'operations_subject_index', columns: ['subject_type', 'subject_id', 'created_at'] },
    { name: 'operations_token_index', columns: ['access_token_id', 'created_at'] },
    // The idempotency lookup, which happens on every create.
    { name: 'operations_idempotency_index', columns: ['idempotency_scope', 'idempotency_key'], unique: true },
  ],

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  attributes: {
    /**
     * What kind of work this is, as a stable string.
     *
     * Not an enum, for the reason the audit log's `action` is not: an enum
     * needs a migration for every new kind of work, and the cost of that is
     * somebody deciding to answer `202` instead.
     */
    kind: {
      order: 1,
      fillable: true,
      required: true,
      validation: { rule: schema.string().required().max(60) },
      factory: () => 'mirror.sync',
    },

    status: {
      order: 2,
      fillable: true,
      default: 'queued',
      validation: { rule: schema.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']) },
      factory: () => 'queued',
    },

    /** What the work is about - a repository, a pull request. */
    subject_type: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => 'repository',
    },

    subject_id: {
      order: 4,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** Who asked. Null for work the system started on its own. */
    actor_id: {
      order: 5,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /**
     * The token that started it, when one did.
     *
     * Cancelling requires the same authority that created it, and "the same
     * authority" cannot be checked without knowing which credential that was.
     * A person's session cancelling their own token's work is fine; another
     * token doing it is not.
     */
    access_token_id: {
      order: 6,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /**
     * The idempotency key, scoped.
     *
     * Two clients will eventually choose the same key - a bad UUID seed, or the
     * literal `1` - so the unique index is over the scope and the key together
     * rather than the key alone. Unscoped, one caller's retry would join
     * another caller's operation, which is a disclosure rather than a
     * duplicate.
     */
    idempotency_scope: {
      order: 7,
      fillable: true,
      validation: { rule: schema.string().max(120) },
      factory: () => null,
    },

    idempotency_key: {
      order: 8,
      fillable: true,
      validation: { rule: schema.string().max(120) },
      factory: () => null,
    },

    /** When it left the queue, and when it stopped. Both ISO 8601. */
    started_at: {
      order: 9,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    finished_at: {
      order: 10,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },

    /**
     * Whatever the work produced, as JSON.
     *
     * Deliberately not columns. What a sync reports and what an import reports
     * have nothing in common, and a table with a column per kind is a table
     * that is mostly null.
     */
    result: {
      order: 11,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: () => null,
    },

    /** Why it failed, in words a caller can act on. */
    error: {
      order: 12,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: () => null,
    },

    /**
     * Somebody asked it to stop.
     *
     * A flag rather than an immediate status change, because stopping is a
     * request rather than an act: the work is running somewhere else and will
     * notice at its next checkpoint. Setting `cancelled` here directly would
     * report the work stopped while it was still going, which is the one lie a
     * status endpoint must not tell.
     */
    cancel_requested_at: {
      order: 13,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => null,
    },
  },
} as const)
