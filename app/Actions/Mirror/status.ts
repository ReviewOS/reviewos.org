/**
 * What a reader needs to know about a mirror, and what an operator needs.
 *
 * A repository page's real question is not "is mirroring enabled" - it is
 * **"is what I am reading current?"**. Somebody about to review a pull request
 * on a mirror is deciding whether to trust the diff in front of them, and
 * "mirror enabled" answers a different question than the one they have.
 *
 * So the summary leads with when it last synced and whether that is recent
 * enough to believe, and only then says what it is a mirror of.
 */

/** How far past its interval a mirror drifts before it is called stalled. */
export const STALE_AFTER_INTERVALS = 3

/** The point at which a mirror is not late but broken. */
export const FAILURES_BEFORE_BROKEN = 3

export type MirrorHealth = 'syncing' | 'stale' | 'failing' | 'disabled' | 'never'

/** A mirror row, as far as health cares. */
export interface MirrorTimingRow {
  enabled: unknown
  interval_seconds: unknown
  last_synced_at: unknown
  last_error: unknown
  failure_count: unknown
}

/**
 * Whether what the reader is looking at can be believed.
 *
 * Five answers rather than a boolean, because they call for different words and
 * two of them are not the mirror's fault:
 *
 * - `never` - configured and has not run yet. Says "not synced yet", which is
 *   honest and temporary.
 * - `syncing` - within its interval, or close enough. The ordinary state.
 * - `stale` - it has run, but not lately. Nothing has errored, so this is the
 *   one that would otherwise be silent: a mirror whose schedule stopped firing
 *   looks identical to a mirror of a quiet repository, and the reader cannot
 *   tell the code they are reading is a month old.
 * - `failing` - erroring repeatedly. Names the error.
 * - `disabled` - switched off deliberately. Not a fault, and saying "stale"
 *   here would send somebody looking for a problem that is a decision.
 */
export function mirrorHealth(mirror: MirrorTimingRow, now: Date = new Date()): MirrorHealth {
  if (!mirror.enabled)
    return 'disabled'

  if (Number(mirror.failure_count ?? 0) >= FAILURES_BEFORE_BROKEN)
    return 'failing'

  const last = mirror.last_synced_at ? Date.parse(String(mirror.last_synced_at)) : Number.NaN

  if (Number.isNaN(last))
    return 'never'

  const interval = Math.max(60, Number(mirror.interval_seconds ?? 3600)) * 1000

  /*
   * Three intervals rather than one. A sweep that runs on a schedule is
   * routinely a little late - the queue is busy, the previous run overlapped -
   * and a mirror that flickers into "stale" every hour teaches people to
   * ignore the word by the time it means something.
   */
  return now.getTime() - last > interval * STALE_AFTER_INTERVALS ? 'stale' : 'syncing'
}

/** What to show, in the words the reader's question is asked in. */
export interface MirrorSummary {
  health: MirrorHealth
  /** `owner/name` upstream, which is the "of what". */
  remote: string
  remoteUrl: string
  lastSyncedAt: string | null
  /** Set only when there is something an operator should act on. */
  problem: string | null
}

export function summarize(mirror: any, now: Date = new Date()): MirrorSummary | null {
  if (!mirror)
    return null

  const health = mirrorHealth(mirror as MirrorTimingRow, now)
  const owner = String(mirror.remote_owner ?? '')
  const name = String(mirror.remote_name ?? '')

  return {
    health,
    remote: owner && name ? `${owner}/${name}` : String(mirror.remote_url ?? ''),
    remoteUrl: String(mirror.remote_url ?? ''),
    lastSyncedAt: mirror.last_synced_at ? String(mirror.last_synced_at) : null,
    problem: problemFor(health, mirror),
  }
}

/**
 * The sentence an operator needs, or null when there is nothing to do.
 *
 * A revoked credential is called out by name rather than left inside the raw
 * git error, because it is the failure with a different fix from all the
 * others: every other error is "wait or retry", and this one is "go and issue a
 * new token". They read identically in a log.
 */
function problemFor(health: MirrorHealth, mirror: any): string | null {
  if (health === 'failing') {
    const error = String(mirror.last_error ?? '')

    return looksLikeRevokedCredential(error)
      ? 'The credential for this mirror is no longer accepted. Re-authorize it to resume syncing.'
      : `Syncing has failed ${Number(mirror.failure_count ?? 0)} times: ${error || 'no reason recorded'}`
  }

  if (health === 'stale')
    return 'This mirror has not synced recently, and nothing has errored. Its schedule may not be running.'

  return null
}

/**
 * Whether an error is the host refusing the credential rather than anything
 * transient.
 *
 * Matched on what the transports actually say. `git` over HTTPS says
 * "Authentication failed"; the API says 401 or "Bad credentials"; a token
 * removed from a private repository's access says 403 or 404 on a repository
 * that plainly exists, which is why a bare 404 counts here - for a mirror that
 * synced successfully yesterday, "not found" almost always means "no longer
 * permitted to see it".
 */
export function looksLikeRevokedCredential(error: string): boolean {
  const text = error.toLowerCase()

  return /authentication failed|bad credentials|invalid.*(token|credential)|401|403/.test(text)
    || /could not read username|terminal prompts disabled/.test(text)
    || /repository not found/.test(text)
}
