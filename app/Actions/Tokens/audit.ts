import { recordAudit } from '../Git/audit'

/**
 * The three things that happen to a token, recorded the same way each time.
 *
 * A token is the one credential nobody watches being used. It has no password
 * prompt, no login notification and no session list, and it outlives the laptop
 * it was pasted into - so the log is the only place its life is written down,
 * and the question it has to answer two years in is "when did this get the
 * ability to write, and who gave it that".
 *
 * A thin wrapper over `recordAudit` rather than three call sites building their
 * own rows, because an audit log is worth exactly as much as its consistency: a
 * caller that assembles its own is one that eventually records a revocation
 * without saying who did it, and nothing reading the log can tell that from a
 * token its owner revoked themselves.
 *
 * **The secret is never in here, in any form.** Not the token, not a truncated
 * token, not a hash. The prefix identifies which token this is and is public by
 * design - it is on the settings page. An audit log is the thing most likely to
 * be shipped somewhere central and read by people who are not administrators,
 * and it must never be a place where a credential can be recovered.
 *
 * Never throws, inherited from `recordAudit` and for the same reason: refusing
 * to issue a token because the log write failed is how audit logging gets
 * turned off.
 */

/*
 * There is deliberately no `token:permissions-changed`.
 *
 * A token's grants cannot be edited in place in this product - the path is to
 * rotate, which issues a replacement and lets the old one expire over an
 * overlap. That is a real design choice rather than a missing screen: a token
 * whose abilities change under a client is a token that starts failing at 3am
 * for a reason nobody connects to a settings page, and a replacement is
 * something the holder has to deliberately install.
 *
 * So a rotation records `token:created` on the replacement carrying `replaces`,
 * and the old token's own line is the expiry it was brought forward to. Adding
 * an event nothing can emit would leave a reader of this file believing the log
 * answers a question it never will.
 */
export type TokenEvent
  = | 'token:created'
    | 'token:first-used'
    | 'token:revoked'

export interface TokenAudit {
  event: TokenEvent
  tokenId: number
  /** The account the token belongs to. The actor is whoever acted, which is not always them. */
  ownerId: number
  /** Public, and the only way a reader tells one of somebody's tokens from another. */
  prefix?: string | null
  actorId?: number | null
  /** The credential the request carried, when the actor used one. */
  actingTokenId?: number | null
  reason?: string | null
  detail?: Record<string, unknown>
  ip?: string | null
}

export async function recordTokenAudit(entry: TokenAudit): Promise<boolean> {
  return await recordAudit({
    action: entry.event,
    subject: { type: 'access_token', id: entry.tokenId },
    /*
     * The acting token, not only the subject one.
     *
     * They are the same row for `token:first-used` - the token is what acted -
     * and different for a revocation done from a browser, where this stays
     * null. Recording it here means "everything a token did" can be answered
     * with one filter rather than by knowing which events happen to name a
     * token in their subject.
     */
    tokenId: entry.actingTokenId ?? (entry.event === 'token:first-used' ? entry.tokenId : null),
    // Defaults to the owner, because two of the three events are somebody
    // acting on their own token. `token:first-used` has no actor at all - it is
    // the token acting - and passing null there is deliberate rather than an
    // omission.
    actorId: entry.actorId === undefined ? entry.ownerId : entry.actorId,
    reason: entry.reason ?? null,
    detail: {
      owner_id: entry.ownerId,
      prefix: entry.prefix ?? null,
      ...entry.detail,
    },
    ip: entry.ip ?? null,
  })
}
