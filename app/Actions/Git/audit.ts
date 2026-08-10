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
  /**
   * The scope this belongs to, for the reads rather than the writes.
   *
   * An organization owner may read their own log, and "every event about a
   * repository this organization owns" is not a question the polymorphic
   * subject can answer without knowing which table the subject lives in.
   */
  organizationId?: number | null
  repositoryId?: number | null
  /** What the client called itself. Untrusted, and the fastest way to tell a script from a person. */
  userAgent?: string | null
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
        organization_id: entry.organizationId ?? null,
        repository_id: entry.repositoryId ?? null,
        user_agent: entry.userAgent?.slice(0, 255) ?? null,
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
    /*
     * This project's own token, and only that.
     *
     * `request._currentAccessToken` is the *framework's* token row, from
     * `oauth_access_tokens` - a different table with its own id space. Reading
     * it here meant a framework-authenticated request recorded somebody else's
     * primary key as an `access_tokens` id: silently wrong attribution in the
     * audit log, and a foreign key violation the moment a column referenced
     * the real table.
     *
     * The middleware and `authorizeRepository` both stash the resolved token,
     * so this is usually a property read. The header is parsed only for a
     * request that reached neither.
     */
    const stashed = request?.__fineGrainedToken
    if (stashed && typeof stashed === 'object') {
      const id = Number((stashed as any).tokenId)

      return Number.isInteger(id) && id > 0 ? id : null
    }

    const header = String(
      request?.headers?.get?.('authorization') ?? request?.header?.('authorization') ?? '',
    )

    if (!header.startsWith('Bearer '))
      return null

    const presented = header.slice('Bearer '.length).trim()
    if (!presented.startsWith('ros_'))
      return null

    const { authenticateToken } = await import('../Tokens/authenticate')
    const result = await authenticateToken(presented)

    return result.ok ? result.token.tokenId : null
  }
  catch {
    // An audit row with the actor and no token is worth writing; one that
    // failed to be written because the lookup threw is not.
    return null
  }
}

/**
 * The parts of an audit entry a request can supply on its own.
 *
 * Spread into a `recordAudit` call so a caller writes one line rather than
 * four, and so a new field added here reaches every call site at once instead
 * of reaching the ones somebody remembered.
 */
export async function auditFrom(request: any): Promise<{ tokenId: number | null, ip: string | null, userAgent: string | null }> {
  return {
    tokenId: await tokenIdFor(request),
    // The first entry of `x-forwarded-for`: the client as the nearest trusted
    // proxy saw it. The rest of that list is whatever the client claimed.
    ip: String(request?.headers?.get?.('x-forwarded-for') ?? '').split(',')[0]?.trim()
      || String(request?.headers?.get?.('x-real-ip') ?? '').trim()
      || null,
    userAgent: String(request?.headers?.get?.('user-agent') ?? '').trim() || null,
  }
}
