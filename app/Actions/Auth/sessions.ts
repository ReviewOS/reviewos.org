/**
 * Reading somebody's own sessions.
 *
 * A session here is a row in `oauth_access_tokens` - the framework's table,
 * the same one the cookie's value hashes to. There is deliberately no second
 * table shadowing it: a companion row recording "this session exists" is a row
 * that goes stale the moment a token is revoked by any path that does not know
 * about it, and the failure mode is a page telling somebody a session is live
 * when it is not.
 *
 * Pure-ish: one query and a hash, so the shaping and the recognition logic
 * below can be tested without a request.
 */

export interface SessionRow {
  id: number
  /** Whether this is the browser doing the reading. */
  current: boolean
  userAgent: string | null
  ipAddress: string | null
  createdAt: string | null
  /** Last used, from `updated_at`, which the validator touches on every request. */
  lastSeenAt: string | null
  expiresAt: string | null
}

/**
 * Every live session for this account, newest use first.
 *
 * Revoked and expired rows are excluded rather than shown greyed out. A list
 * that includes them is a list where the thing somebody is looking for - the
 * session they do not recognise - is buried among rows that cannot do anything,
 * and the point of this page is that it can be scanned.
 */
export async function sessionsFor(userId: number, currentToken: string): Promise<SessionRow[]> {
  const db = (globalThis as any).db
  const hashed = currentToken ? await hashOf(currentToken) : ''

  let rows: any[] = []

  try {
    rows = await db
      .selectFrom('oauth_access_tokens')
      .select(['id', 'token', 'user_agent', 'ip_address', 'created_at', 'updated_at', 'expires_at'])
      .where('user_id', '=', userId)
      .where('revoked', '=', false)
      .orderBy('updated_at', 'desc')
      .execute()
  }
  catch {
    // An instance whose auth tables predate the device columns answers with an
    // empty list rather than a 500. The settings page then says there are no
    // other sessions, which is wrong but harmless; a stack trace on a security
    // page is neither.
    return []
  }

  const now = Date.now()

  return rows
    .filter((row) => {
      const expires = row.expires_at ? Date.parse(String(row.expires_at)) : Number.NaN

      return !Number.isFinite(expires) || expires > now
    })
    .map(row => ({
      id: Number(row.id),
      current: Boolean(hashed) && String(row.token) === hashed,
      userAgent: row.user_agent ? String(row.user_agent) : null,
      ipAddress: row.ip_address ? String(row.ip_address) : null,
      createdAt: row.created_at ? String(row.created_at) : null,
      lastSeenAt: row.updated_at ? String(row.updated_at) : null,
      expiresAt: row.expires_at ? String(row.expires_at) : null,
    }))
}

/**
 * The hash the token column stores, so the current row can be marked.
 *
 * The framework hashes with a plain SHA-256 of the plaintext. Recomputed here
 * rather than imported, because the import is `hashToken` from a package whose
 * shape has changed twice - and a marker that silently stops matching would
 * make every row look like somebody else's, which is exactly the alarm this
 * page must not raise falsely.
 */
async function hashOf(plaintext: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plaintext))

  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * A user agent as something a person recognises.
 *
 * Deliberately coarse. The goal is "is this me?" answered at a glance, and a
 * full user-agent string answers it worse than "Chrome on macOS" does - it is
 * ninety characters of version numbers, and the differences between two of your
 * own browsers are buried in the middle. The raw string is returned alongside
 * for anybody who wants it.
 *
 * Order matters: Edge and Opera both claim to be Chrome, Chrome claims to be
 * Safari, and every one of them claims to be Mozilla. Matching the most
 * specific first is the only way this is ever right.
 */
export function describeAgent(agent: string | null): string {
  if (!agent)
    return 'Unknown device'

  const browser
    = /\bEdgA?\//.test(agent)
      ? 'Edge'
      : /\bOPR\//.test(agent)
        ? 'Opera'
        : /\bFirefox\//.test(agent)
          ? 'Firefox'
          : /\bChrome\//.test(agent)
            ? 'Chrome'
            : /\bSafari\//.test(agent)
              ? 'Safari'
              // A git client, a script, a bot. Named rather than called
              // unknown: a session held by `curl` is exactly the row somebody
              // is scanning for.
              : /\bcurl\/|\bwget\/|\bgit\//i.test(agent)
                ? agent.split('/')[0] ?? 'A command-line client'
                : 'A browser'

  const platform
    = /\biPhone\b/.test(agent)
      ? 'iPhone'
      : /\biPad\b/.test(agent)
        ? 'iPad'
        : /\bAndroid\b/.test(agent)
          ? 'Android'
          // `Mac OS X` before `X11`, because a Mac's string contains neither
          // the other's marker but Linux browsers sometimes carry both.
          : /\bMac OS X\b/.test(agent)
            ? 'macOS'
            : /\bWindows\b/.test(agent)
              ? 'Windows'
              : /\bLinux\b|\bX11\b/.test(agent)
                ? 'Linux'
                : ''

  return platform ? `${browser} on ${platform}` : browser
}
