import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Something somebody did that has to be answerable for afterwards.
 *
 * Written for the push-protection bypass, which is the first thing in this
 * product where the honest answer to "why is that credential in the
 * repository?" has to be a record rather than a memory. It is deliberately
 * general, because the second and third things - a token issued, a repository
 * transferred, a protected branch rule removed - want the same row and would
 * otherwise each grow their own table.
 *
 * ## An entry is never edited and never deleted
 *
 * There is no `updated_at`, and nothing in the application updates one of these.
 * A log that can be corrected is a log that has to be trusted rather than read,
 * and the whole value of this table is that the row is what happened.
 *
 * The actor is optional for the same reason it is on `IssueComment`: not
 * everything is done by somebody with an account here. A push arriving over
 * HTTP carries a token that names its owner, and one arriving another way may
 * not - and "nobody knows who" is a fact worth recording accurately rather than
 * attributing to the nearest plausible user.
 */
export default defineModel({
  name: 'AuditEvent',
  table: 'audit_events',
  primaryKey: 'id',
  autoIncrement: true,

  indexes: [
    // The two questions anybody asks of this table: what happened to this
    // repository, and what has this person been doing.
    { name: 'audit_events_subject_index', columns: ['subject_type', 'subject_id', 'created_at'] },
    { name: 'audit_events_actor_index', columns: ['actor_id', 'created_at'] },
  ],

  traits: {
    useUuid: true,
    // Created only. An entry that could be updated would be an entry somebody
    // could quietly correct.
    useTimestamps: true,
    useSeeder: { count: 0 },
  },

  /*
   * `SET NULL`, and deliberately not a cascade.
   *
   * A cascade here would delete the audit trail along with the account, which
   * is precisely backwards: the records that matter most are the ones about
   * somebody who is gone. Leaving no rule at all was not right either - it made
   * a user with any audit history undeletable, so the account deletion path
   * failed on a foreign key rather than doing anything.
   *
   * So the event survives and forgets who. `external_actor` and `detail` still
   * carry what was recorded at the time, which is what a reader needs; the
   * account behind the id is gone and there is nothing useful to point at.
   */
  belongsTo: [{ model: 'User', foreignKey: 'actor_id', onDelete: 'set null' }],

  attributes: {
    /**
     * What happened, as a stable string.
     *
     * Not an enum. An enum needs a migration for every new kind of event, and
     * the cost of that is somebody deciding not to record something - which is
     * the one failure mode an audit log cannot have.
     */
    action: {
      order: 1,
      fillable: true,
      validation: { rule: schema.string().required().max(80) },
      factory: () => 'push.protection.bypassed',
    },

    subject_type: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => 'repository',
    },

    subject_id: {
      order: 3,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** The local actor, when there is one. */
    actor_id: {
      order: 4,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /**
     * The token the request carried, when it carried one.
     *
     * Attribution to the account alone is not enough once agents are
     * contributors. An account can hold a personal token, a CI token and an
     * agent's token at once, and "chris deleted the repository" is a very
     * different sentence from "the deploy token chris issued in March deleted
     * the repository" - the first sends somebody to ask Chris, the second sends
     * them to revoke a credential.
     *
     * Null for anything a person did in a browser, which is most of the log.
     * That absence is itself the signal: a session did it, not a token.
     */
    access_token_id: {
      order: 5,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    /** Who, when there is no local account - a token owner, a remote name. */
    external_actor: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(120) },
      factory: () => null,
    },

    /**
     * What the person said they were doing.
     *
     * On a bypass this is the required reason, which is the whole point of
     * requiring one: the words are less useful than the fact that somebody had
     * to write them.
     */
    reason: {
      order: 7,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: () => null,
    },

    /**
     * Everything else, as JSON.
     *
     * The findings that were overridden, the ref, the sha. Deliberately not
     * columns: what an event needs to record differs per action, and a table
     * with a column per action is a table that is mostly null.
     */
    detail: {
      order: 8,
      fillable: true,
      type: 'text',
      validation: { rule: schema.string() },
      factory: () => null,
    },

    ip_address: {
      order: 9,
      fillable: true,
      validation: { rule: schema.string().max(45) },
      factory: () => null,
    },
  },
} as const)
