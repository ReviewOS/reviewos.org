import type { AuditPayload } from '../Audit/events'
import { AUDIT_EVENTS } from '../Audit/events'
import { recordAudit } from '../Actions/Git/audit'

/**
 * Write down that something auditable happened.
 *
 * One listener over every security event, for the reason `RecordActivity` is
 * one listener over every domain event: they all do the same thing, and twenty
 * listeners would be twenty copies of it with the action string changed. The
 * twentieth would be the one that forgets the organization, and an event
 * without a scope is an event its owner cannot see.
 *
 * **This is the only writer.** `recordAudit` is exported and could be called
 * directly, and nothing outside this file does: a caller that assembles its own
 * row is a caller that will one day record a revocation without saying who did
 * it, and nothing reading the log can tell that from a token its owner revoked
 * themselves.
 *
 * Never throws. `recordAudit` already swallows a failed insert, and this adds
 * the same promise around everything before it: by the time this runs the
 * repository is gone, the role has changed, the token is revoked. The record is
 * worth a great deal and it is not worth more than the thing it describes.
 */
export default {
  listensTo: [...AUDIT_EVENTS],

  async handle(payload: AuditPayload & { event?: string }, eventName?: string): Promise<void> {
    try {
      // Both accepted, for the reason written in `Notify`: the two event
      // libraries in play disagree about whether a handler is told which event
      // fired, and guessing wrong files every row under the first action.
      const action = String(payload?.event ?? eventName ?? '')

      // An event with no name would be a row saying something happened without
      // saying what, which is worse than no row: it is a gap that looks like
      // coverage.
      if (!action)
        return

      await recordAudit({
        action,
        subject: payload.subject ?? null,
        actorId: payload.actorId ?? null,
        tokenId: payload.tokenId ?? null,
        organizationId: payload.organizationId ?? null,
        repositoryId: payload.repositoryId ?? null,
        externalActor: payload.externalActor ?? null,
        userAgent: payload.userAgent ?? null,
        reason: payload.reason ?? null,
        detail: payload.detail,
        ip: payload.ip ?? null,
      })
    }
    catch (error) {
      // Reported rather than swallowed silently. An audit log that quietly
      // stopped filling reads exactly like a quiet month, which is the failure
      // this whole subsystem exists to prevent.
      console.error('[audit] could not record:', error)
    }
  },
}
