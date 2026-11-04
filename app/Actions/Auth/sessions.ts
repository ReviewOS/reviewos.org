export interface SessionRow {
  /** Legacy API sign-ins retain their numeric wire identifiers. */
  id: number | string
  current: boolean
  userAgent: string | null
  ipAddress: string | null
  createdAt: string | null
  lastSeenAt: string | null
  expiresAt: string | null
}

/** Framework-owned live credentials, scoped to their owner. No secrets leave it. */
export async function sessionsFor(userId: number, currentCredential: string): Promise<SessionRow[]> {
  const { browserSessions } = await import('@stacksjs/auth')
  return (await browserSessions(userId, currentCredential)).map(session => ({
    ...session,
    id: session.id.startsWith('access:') ? Number(session.id.slice('access:'.length)) : session.id,
  }))
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
