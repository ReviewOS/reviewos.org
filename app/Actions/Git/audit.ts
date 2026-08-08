/**
 * Writing to the audit log.
 *
 * One function, because the value of an audit log is that everything reaches it
 * the same way. A caller that builds its own row is a caller that will one day
 * forget the actor, or the reason, or record the finding it overrode in a shape
 * nothing else can read.
 *
 * Never throws, and that is a real decision rather than a convenience. The
 * alternative - failing the operation when the log write fails - means a
 * database hiccup refuses a push that was allowed, which is the sort of thing
 * that gets audit logging removed. The record is worth a great deal and it is
 * not worth more than the thing it describes.
 */

export interface AuditEntry {
  action: string
  subject?: { type: string, id: number } | null
  actorId?: number | null
  /**
   * The token the request carried, when it carried one.
   *
   * Absent for anything done in a browser, which is most of the log. `tokenIdFor`
   * reads it off a request so a call site never has to know where the router
   * keeps it.
   */
  tokenId?: number | null
  externalActor?: string | null
  reason?: string | null
  detail?: unknown
  ip?: string | null
}

export async function recordAudit(entry: AuditEntry): Promise<boolean> {
  try {
    await db
      .insertInto('audit_events')
      .values({
        action: entry.action.slice(0, 80),
        subject_type: entry.subject?.type?.slice(0, 40) ?? null,
        subject_id: entry.subject?.id ?? null,
        actor_id: entry.actorId ?? null,
        access_token_id: entry.tokenId ?? null,
        external_actor: entry.externalActor?.slice(0, 120) ?? null,
        reason: entry.reason ?? null,
        // Serialized here rather than at the call site, so every row's `detail`
        // is JSON and a reader never has to guess which ones are.
        detail: entry.detail === undefined ? null : JSON.stringify(entry.detail),
        ip_address: entry.ip?.slice(0, 45) ?? null,
      })
      .execute()

    return true
  }
  catch {
    return false
  }
}

/**
 * The id of the access token this request authenticated with, or null.
 *
 * A single place to ask, because the answer lives in a router internal
 * (`_currentAccessToken`, populated by the auth middleware) and every call site
 * that reached for it directly would be a call site that breaks silently when
 * the internal is renamed - silently because a missing token id looks exactly
 * like a browser session.
 *
 * Never throws. An audit row with the actor and no token is worth writing; one
 * that failed to be written because the lookup threw is not.
 */
export async function tokenIdFor(request: any): Promise<number | null> {
  try {
    const token = request?._currentAccessToken ?? await request?.userToken?.()
    const id = Number((token as any)?.id)

    return Number.isInteger(id) && id > 0 ? id : null
  }
  catch {
    return null
  }
}
