/**
 * Whether what the reader is looking at can be believed.
 *
 * A repository page's real question about a mirror is not "is mirroring
 * enabled" - it is "is this current?". Somebody about to review a pull request
 * on a mirror is deciding whether to trust the diff in front of them.
 *
 * The state worth the most here is `stale`: a mirror whose schedule stopped
 * firing has no error and looks exactly like a mirror of a quiet repository, so
 * without this the reader is told nothing and reads month-old code believing it
 * is today's.
 */

import { describe, expect, it } from 'bun:test'
import { looksLikeRevokedCredential, mirrorHealth, summarize } from '../../app/Actions/Mirror/status'

const now = new Date('2026-08-08T12:00:00Z')

function mirror(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    interval_seconds: 3600,
    last_synced_at: '2026-08-08T11:30:00Z',
    last_error: null,
    failure_count: 0,
    ...overrides,
  }
}

describe('health', () => {
  it('is syncing inside the interval', () => {
    expect(mirrorHealth(mirror(), now)).toBe('syncing')
  })

  it('tolerates being a little late, so the word keeps its meaning', () => {
    /*
     * A sweep on a schedule is routinely late - the queue is busy, the previous
     * run overlapped. A mirror that flickers into "stale" every hour teaches
     * people to ignore the word by the time it means something.
     */
    expect(mirrorHealth(mirror({ last_synced_at: '2026-08-08T10:15:00Z' }), now)).toBe('syncing')
  })

  it('is stale past three intervals, which is the silent failure', () => {
    // Nothing has errored. This is a mirror whose schedule stopped firing, and
    // it is indistinguishable from a quiet repository without being said.
    expect(mirrorHealth(mirror({ last_synced_at: '2026-08-08T07:00:00Z' }), now)).toBe('stale')
  })

  it('is never rather than stale before its first run', () => {
    // "Not synced yet" is honest and temporary; "stale" sends somebody looking
    // for a fault in something that has not had a chance to run.
    expect(mirrorHealth(mirror({ last_synced_at: null }), now)).toBe('never')
  })

  it('is failing once the errors repeat, whatever the clock says', () => {
    expect(mirrorHealth(mirror({ failure_count: 3, last_synced_at: '2026-08-08T11:59:00Z' }), now)).toBe('failing')
  })

  it('is disabled rather than stale when it was switched off', () => {
    // A decision, not a fault. Calling it stale sends somebody looking for a
    // problem somebody else already solved.
    expect(mirrorHealth(mirror({ enabled: false, last_synced_at: '2020-01-01T00:00:00Z' }), now)).toBe('disabled')
  })
})

describe('a revoked credential', () => {
  it('is recognised across the shapes the transports use', () => {
    /*
     * Called out by name because it is the failure with a different fix from
     * every other: the rest are "wait or retry", this one is "go and issue a
     * new token", and they read identically in a log.
     */
    for (const error of [
      'fatal: Authentication failed for https://github.com/acme/api.git',
      '401 Bad credentials',
      'remote: Invalid username or token',
      'could not read Username for https://github.com: terminal prompts disabled',
      'remote: Repository not found.',
    ]) {
      expect(looksLikeRevokedCredential(error)).toBe(true)
    }
  })

  it('does not claim one for an ordinary network failure', () => {
    // Misreading a timeout as a revoked token tells somebody to go and rotate a
    // credential that was fine, and leaves the real cause unlooked-at.
    for (const error of [
      'fatal: unable to access: Could not resolve host: github.com',
      'error: RPC failed; curl 56 Recv failure: Connection reset by peer',
      'fatal: the remote end hung up unexpectedly',
    ]) {
      expect(looksLikeRevokedCredential(error)).toBe(false)
    }
  })
})

describe('the summary', () => {
  it('names the remote, so "of what" is answerable without another query', () => {
    const summary = summarize(mirror({ remote_owner: 'acme', remote_name: 'api' }), now)

    expect(summary?.remote).toBe('acme/api')
  })

  it('says what to do about a revoked credential rather than showing the raw error', () => {
    const summary = summarize(mirror({ failure_count: 5, last_error: 'fatal: Authentication failed' }), now)

    expect(summary?.problem).toContain('Re-authorize')
  })

  it('names the count and the reason for any other repeated failure', () => {
    const summary = summarize(mirror({ failure_count: 4, last_error: 'Could not resolve host' }), now)

    expect(summary?.problem).toContain('4 times')
    expect(summary?.problem).toContain('Could not resolve host')
  })

  it('has no problem to report when it is simply syncing', () => {
    // Null rather than an empty string, so a page can branch on it without
    // rendering an empty warning box.
    expect(summarize(mirror(), now)?.problem).toBeNull()
  })

  it('is null for a repository that is not a mirror', () => {
    expect(summarize(null)).toBeNull()
  })
})
