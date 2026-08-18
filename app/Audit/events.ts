/**
 * The events that reach the audit log, and how one is emitted.
 *
 * ## Why this is a listener rather than a call
 *
 * The log used to be written by `recordAudit` called directly from whichever
 * action happened to remember. That works exactly as long as somebody is
 * remembering, and the failure is invisible: nothing is missing from the screen
 * when a new endpoint forgets to record what it did, and the gap is discovered
 * by the person reconstructing an incident, months later, at the moment it
 * matters most.
 *
 * So the shape is the one the activity feed already uses. An action emits what
 * it did, and one listener decides what that means and writes it down. The
 * value is not indirection for its own sake: it is that **the list of auditable
 * things is a list in one file**, so "is a role change recorded?" is a question
 * this file answers, rather than a search through every action for a call.
 *
 * ## The event name is the action
 *
 * `member:role-changed` in the code is `member:role-changed` in the `action`
 * column. One string, so somebody reading a log line can grep the codebase for
 * it and land on the emitter.
 *
 * The two earliest events were written `repository.transferred` and
 * `push.protection.bypassed`, with dots, before there were enough of them for a
 * convention to be visible. Everything else in this codebase - `pr:opened`,
 * `mirror:synced`, `token:created` - uses a colon, so these were changed to
 * match. No instance exists yet, so the cost of that consistency is a handful
 * of rows in a development database now, against a permanent split in the one
 * table nobody can rewrite later.
 */

import { dispatchAsync } from '@stacksjs/events'

/**
 * Everything the log records, as a closed list.
 *
 * Closed on purpose, and the one place in this system where an enum is right.
 * The `action` column is deliberately a free string - a migration per new event
 * is how somebody ends up deciding not to record something - but the *emitters*
 * are checked against this, so a typo is a type error rather than a row nobody
 * will ever find because they are searching for the spelling they meant.
 */
export type AuditEventName =
  // Permission and role changes.
  | 'member:invited'
  | 'member:joined'
  | 'member:role-changed'
  | 'member:removed'
  | 'collaborator:changed'
  | 'collaborator:removed'
  | 'team:access-changed'
  // Token and key lifecycle.
  | 'token:created'
  | 'token:first-used'
  | 'token:revoked'
  | 'key:added'
  | 'key:removed'
  | 'session:revoked'
  | 'sso:signed-in'
  | 'sso:provisioned'
  | 'sso:deprovisioned'
  | 'passkey:registered'
  | 'passkey:removed'
  | 'two-factor:enabled'
  | 'two-factor:disabled'
  | 'two-factor:recovery-codes-reissued'
  // Protected branches and the rules on them.
  | 'branch:protection-changed'
  | 'branch:protection-removed'
  | 'push:protection-bypassed'
  // Visibility, transfers, deletions.
  | 'repository:visibility-changed'
  | 'repository:transferred'
  | 'repository:deleted'
  | 'organization:deleted'
  // Administrative action.
  | 'instance:setting-changed'
  | 'admin:granted'
  | 'admin:revoked'
  | 'admin:job-retried'
  /*
   * The fleet. Worth recording because these are boundary changes that are
   * invisible afterwards: adding the first repository to a pool is the moment
   * it stops serving every repository, removing the last one is the moment it
   * starts again, and a paused queue is why nothing has built since lunch.
   */
  | 'fleet:pool-created'
  | 'fleet:queue-created'
  | 'workflow:fork-run-approved'
  | 'workflow:fork-run-refused'
  | 'fleet:signatures-required'
  | 'fleet:plugin-attached'
  | 'fleet:plugin-detached'
  | 'fleet:plugin-policy-set'
  | 'fleet:queue-paused'
  | 'fleet:queue-resumed'
  | 'fleet:repository-assigned'
  | 'fleet:repository-unassigned'
  | 'fleet:runner-assigned'
  | 'fleet:runner-created'
  | 'fleet:runner-registered'
  | 'fleet:token-created'
  | 'fleet:token-revoked'
  | 'fleet:maintainer-added'
  | 'fleet:maintainer-removed'
  | 'fleet:runner-stopped'
  | 'audit:exported'

/**
 * Every event, as a list.
 *
 * Derived by hand from the type above rather than the other way round, because
 * a type does not survive to runtime and the listener needs to say what it
 * listens to. `tests/unit/audit-events.test.ts` asserts the two agree, which is
 * the part that would otherwise drift.
 */
export const AUDIT_EVENTS: readonly AuditEventName[] = [
  'member:invited',
  'member:joined',
  'member:role-changed',
  'member:removed',
  'collaborator:changed',
  'collaborator:removed',
  'team:access-changed',
  'token:created',
  'token:first-used',
  'token:revoked',
  'key:added',
  'key:removed',
  'session:revoked',
  'sso:signed-in',
  'sso:provisioned',
  'sso:deprovisioned',
  'passkey:registered',
  'passkey:removed',
  'two-factor:enabled',
  'two-factor:disabled',
  'two-factor:recovery-codes-reissued',
  'branch:protection-changed',
  'branch:protection-removed',
  'push:protection-bypassed',
  'repository:visibility-changed',
  'repository:transferred',
  'repository:deleted',
  'organization:deleted',
  'instance:setting-changed',
  'admin:granted',
  'admin:revoked',
  'admin:job-retried',
  'fleet:pool-created',
  'workflow:fork-run-approved',
  'workflow:fork-run-refused',
  'fleet:signatures-required',
  'fleet:plugin-attached',
  'fleet:plugin-detached',
  'fleet:plugin-policy-set',
  'fleet:queue-created',
  'fleet:queue-paused',
  'fleet:queue-resumed',
  'fleet:repository-assigned',
  'fleet:repository-unassigned',
  'fleet:runner-assigned',
  'fleet:runner-created',
  'fleet:runner-registered',
  'fleet:token-created',
  'fleet:token-revoked',
  'fleet:maintainer-added',
  'fleet:maintainer-removed',
  'fleet:runner-stopped',
  'audit:exported',
] as const

export interface AuditPayload {
  /**
   * Who did it.
   *
   * Null is a real answer rather than a missing one: a push arriving with a
   * deploy key has no person behind it, and attributing it to the nearest
   * plausible user is worse than recording that nobody knows.
   */
  actorId?: number | null
  /** The credential the request carried, when it carried one. */
  tokenId?: number | null
  ip?: string | null
  userAgent?: string | null
  /** What it happened to. */
  subject: { type: string, id: number }
  /**
   * The scope, for the reads.
   *
   * An organization owner reads their own log, and that is a `WHERE` on this
   * column. An event that concerns an organization and does not set it is an
   * event its owner cannot see.
   */
  organizationId?: number | null
  repositoryId?: number | null
  /** Who, when there is no local account: a token owner, a remote name. */
  externalActor?: string | null
  /** What the person said they were doing. Required on a bypass. */
  reason?: string | null
  /** Everything specific to this event. Serialized by the writer, not here. */
  detail?: Record<string, unknown>
}

/**
 * Record that something auditable happened.
 *
 * **Awaited, unlike `notify`.** A notification that arrives a moment after the
 * response is a notification that arrived; an audit row that has not been
 * written when the process is killed is a thing that did not happen as far as
 * anybody afterwards can tell. `dispatchAsync` waits for the listener, and
 * swallows its errors, so the caller pays a single insert and cannot be failed
 * by it.
 *
 * **Emitted after the write, never before.** Every caller has already changed
 * something by the time this runs. An event sent first and then rolled back is
 * a permanent record of something that did not happen, in the one table whose
 * value is that its rows are true.
 *
 * Never throws, for the reason `recordAudit` does not: refusing an operation
 * that succeeded because the log write failed is how audit logging gets turned
 * off.
 */
export async function auditEvent(event: AuditEventName, payload: AuditPayload): Promise<void> {
  try {
    // The name travels in the payload as well as being the channel, for the
    // same reason it does in `notify`: the two event libraries in play disagree
    // about whether a handler is told which event fired, and guessing wrong
    // files every row under the first action in the list.
    await dispatchAsync(event as never, { ...payload, event } as never)
  }
  catch (error) {
    console.error(`[audit] ${event} could not be emitted:`, error)
  }
}
