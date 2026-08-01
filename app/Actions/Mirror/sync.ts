/**
 * Deciding what a mirror sync means.
 *
 * Everything here is pure: it takes ref snapshots and mirror rows and works out
 * what changed, what to report, and when to try again. Fetching lives in
 * `fetch.ts` and the job wires the two together, so the rules can be tested
 * without a network or a repository on disk.
 */

/** A ref name mapped to the sha it points at. */
export type RefSnapshot = Record<string, string>

export interface RefChange {
  ref: string
  before: string | null
  after: string | null
  kind: 'created' | 'updated' | 'deleted'
}

/**
 * Parse `git for-each-ref --format='%(refname) %(objectname)'`.
 *
 * Split on the first space only: a ref name cannot contain a space, but being
 * strict about which space costs nothing and stops a surprising name from
 * producing a sha with a fragment of the name glued to it.
 */
export function parseRefSnapshot(stdout: string): RefSnapshot {
  const snapshot: RefSnapshot = {}

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const space = trimmed.indexOf(' ')
    if (space <= 0) continue

    const ref = trimmed.slice(0, space)
    const sha = trimmed.slice(space + 1).trim()
    if (!ref || !sha) continue

    snapshot[ref] = sha
  }

  return snapshot
}

/**
 * What changed between two snapshots.
 *
 * Deletions matter as much as additions. Without them a branch removed
 * upstream lingers here forever, and a branch list that never shrinks slowly
 * stops meaning anything - which is why the fetch uses `--prune` and why this
 * reports what the prune removed.
 */
export function diffRefs(before: RefSnapshot, after: RefSnapshot): RefChange[] {
  const changes: RefChange[] = []

  for (const [ref, sha] of Object.entries(after)) {
    const previous = before[ref]
    if (previous === undefined) changes.push({ ref, before: null, after: sha, kind: 'created' })
    else if (previous !== sha) changes.push({ ref, before: previous, after: sha, kind: 'updated' })
  }

  for (const [ref, sha] of Object.entries(before)) {
    if (after[ref] === undefined) changes.push({ ref, before: sha, after: null, kind: 'deleted' })
  }

  // Stable order so a summary of the same sync reads the same twice.
  return changes.sort((a, b) => a.ref.localeCompare(b.ref))
}

/**
 * Whether an update rewrote history rather than adding to it.
 *
 * Cannot be decided from the shas alone - it needs to know whether the old
 * commit is still an ancestor of the new one - so the caller supplies that
 * answer and this stays pure. A rewrite is shown rather than absorbed
 * silently: someone reading a mirror deserves to know the history moved.
 */
export function isForcePush(change: RefChange, oldIsAncestorOfNew: boolean): boolean {
  return change.kind === 'updated' && !oldIsAncestorOfNew
}

/**
 * Seconds to wait after a failure.
 *
 * Doubles per consecutive failure and stops at an hour. A mirror whose remote
 * has gone gets retried a handful of times and then rarely, instead of hammering
 * a dead host every fifteen minutes forever.
 */
export function backoffSeconds(failureCount: number, base = 60, max = 3600): number {
  if (failureCount <= 0) return 0
  return Math.min(max, base * 2 ** (failureCount - 1))
}

export interface MirrorTiming {
  enabled: boolean
  interval_seconds: number
  last_synced_at: string | null
  failure_count: number
}

/**
 * Whether a mirror is due to sync.
 *
 * A mirror that has never synced is always due: it has nothing to show yet, and
 * waiting an interval before the first fetch makes a newly created mirror look
 * broken.
 */
export function isDue(mirror: MirrorTiming, now: Date = new Date()): boolean {
  if (!mirror.enabled) return false
  if (!mirror.last_synced_at) return true

  const last = new Date(mirror.last_synced_at)
  if (Number.isNaN(last.getTime())) return true

  const wait = mirror.interval_seconds + backoffSeconds(mirror.failure_count)
  return now.getTime() - last.getTime() >= wait * 1000
}

/** Failures after which a mirror stops being retried and says so. */
export const MAX_CONSECUTIVE_FAILURES = 10

/**
 * Whether repeated failure should disable the mirror.
 *
 * Disabling is a statement, not a silence: the row keeps its `last_error`, and
 * the interface can say the mirror stopped and why, rather than showing stale
 * data as if it were live.
 */
export function shouldDisable(failureCount: number): boolean {
  return failureCount >= MAX_CONSECUTIVE_FAILURES
}

/**
 * A one-line summary of a sync, for the repository page and the log.
 *
 * Counts rather than a list: a sync that moved four hundred refs should not
 * produce four hundred lines, and the number is what a reader actually wants.
 */
export function describeChanges(changes: readonly RefChange[]): string {
  if (changes.length === 0) return 'no changes'

  const created = changes.filter(c => c.kind === 'created').length
  const updated = changes.filter(c => c.kind === 'updated').length
  const deleted = changes.filter(c => c.kind === 'deleted').length

  const parts: string[] = []
  if (created) parts.push(`${created} new`)
  if (updated) parts.push(`${updated} updated`)
  if (deleted) parts.push(`${deleted} removed`)

  return parts.join(', ')
}

/**
 * The remote's default-branch head from a snapshot, if it has one.
 *
 * Used to spot a rewrite of the branch people actually look at, which is the
 * one worth reporting.
 */
export function headOf(snapshot: RefSnapshot, defaultBranch: string): string | null {
  return snapshot[`refs/heads/${defaultBranch}`] ?? null
}

/**
 * Whether a GitHub webhook event should trigger a sync.
 *
 * Only events that change what a mirror shows. A `star` event arrives often and
 * changes nothing here, and syncing on it would turn popularity into load.
 */
export function webhookTriggersSync(event: string): boolean {
  return ['push', 'create', 'delete', 'pull_request', 'issues', 'issue_comment', 'release'].includes(event)
}

/**
 * Match an incoming webhook to a mirror by its remote coordinates.
 *
 * Matching on `owner/name` rather than the URL, because the same repository is
 * reachable as https, ssh and with or without `.git`, and a mirror configured
 * with one spelling must still match a hook that used another.
 */
export function remoteKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase().replace(/\.git$/, '')}`
}
