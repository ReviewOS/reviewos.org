/**
 * The write-ahead log for pushes.
 *
 * Every push becomes a row that says which refs moved and a bundle of the
 * objects that moved with them. The row is written *before* the push is
 * allowed, and committed when it has landed.
 *
 * ## Why a bundle, and why from the quarantine
 *
 * While `pre-receive` runs, git has written the incoming objects into a
 * quarantine directory and has not linked them into the repository. Phase 2
 * already forwards that environment for secret scanning, and it is exactly
 * what is needed here: `git bundle create` against the quarantine produces a
 * self-contained, self-verifying incremental pack of precisely the new
 * objects. Not a copy of the repository - the difference.
 *
 * `git bundle verify` then checks it, which is why this is a backup somebody
 * can trust rather than a directory of files nobody has ever restored from.
 *
 * ## Not every push has a bundle
 *
 * A deletion introduces no objects. A branch pointed at a commit that is
 * already here introduces none either. Those rows carry `blob_key: null`, and
 * that is a fact about the push rather than a failed write - the row is the
 * truth, the bundle is payload.
 *
 * ## The sequence is the ordering
 *
 * Per repository, dense, monotonic, allocated in the same statement that
 * writes the row. Not a timestamp: two pushes in one millisecond are ordinary
 * and clocks move backwards. `replay` walks it in order, which is what makes
 * "restore this repository to sequence 40" a question with one answer.
 */

import type { RefUpdate } from './push'
import { db } from '@stacksjs/database'
import { blobStore } from './blobs'
import { runGit, spawnGitLimited } from './git'
import type { QuarantineEnv } from './scan'

/** One ref's movement, as the log records it. */
export interface WalRefUpdate {
  ref: string
  before: string
  after: string
}

export interface WalEntry {
  id: number
  repositoryId: number
  sequence: number
  updates: WalRefUpdate[]
  blobKey: string | null
  blobBytes: number
  status: 'pending' | 'committed' | 'void'
}

/** How long a bundle may take to write before it is abandoned. */
const BUNDLE_TIMEOUT_MS = 10 * 60_000

/** The blob key a repository's bundle for one sequence lives at. */
export function bundleKey(repositoryId: number, sequence: number): string {
  // Zero-padded so a lexical listing of the store is also chronological, which
  // is what makes `list` usable for finding a replay's starting point.
  return `wal/${repositoryId}/${String(sequence).padStart(12, '0')}.bundle`
}

/** The refs a push moved, in the shape the log stores. */
export function walUpdatesFrom(updates: readonly RefUpdate[]): WalRefUpdate[] {
  return updates.map(update => ({ ref: update.ref, before: update.before, after: update.after }))
}

/**
 * Whether this push brought objects worth bundling.
 *
 * Deletions never do. Everything else might, and asking git is cheaper than
 * guessing: a bundle of nothing fails to create rather than producing an empty
 * file, which is the honest signal.
 */
export function carriesObjects(updates: readonly WalRefUpdate[]): boolean {
  return updates.some(update => update.after && !/^0{40}$/.test(update.after))
}

/**
 * The `git bundle create` argument list, extracted so a test can assert it
 * without spawning git.
 *
 * `--stdout` so the bundle streams into the blob store rather than through a
 * temporary file: the push path already has the objects, and writing them to
 * disk twice is the difference between a WAL that costs nothing and one an
 * operator turns off.
 *
 * The revisions are the new tips, with everything already reachable excluded -
 * the same shape `commitRange` uses for scanning, and for the same reason. A
 * bundle of "everything reachable from this tip" on the first push of a fork
 * is the whole upstream history.
 */
export function bundleArgs(updates: readonly WalRefUpdate[], excludeRefs: readonly string[]): string[] {
  const tips = updates
    .filter(update => update.after && !/^0{40}$/.test(update.after))
    .map(update => update.after)

  return [
    'bundle',
    'create',
    '--quiet',
    '-',
    ...tips,
    ...excludeRefs.map(ref => `^${ref}`),
  ]
}

export interface RecordPushInput {
  repositoryId: number
  repositoryPath: string
  updates: readonly WalRefUpdate[]
  quarantine?: QuarantineEnv
  /** Refs already in the repository, so the bundle carries only what is new. */
  excludeRefs?: readonly string[]
  actorId?: number | null
}

/**
 * Write the pending row and its bundle.
 *
 * Order matters: the bundle goes to the store *before* the row is committed as
 * pending, so a row never points at a blob that is not there. The reverse
 * would produce a log whose entries cannot be replayed, which is worse than no
 * log because it looks like a backup.
 */
export async function recordPush(input: RecordPushInput): Promise<WalEntry | null> {
  const updates = [...input.updates]

  if (updates.length === 0)
    return null

  const sequence = await nextSequence(input.repositoryId)

  let blobKey: string | null = null
  let blobBytes = 0

  if (carriesObjects(updates)) {
    const written = await writeBundle(input, sequence)

    if (written) {
      blobKey = written.key
      blobBytes = written.size
    }
  }

  const row: any = await db.insertInto('git_wal_entries').values({
    repository_id: input.repositoryId,
    sequence,
    updates: JSON.stringify(updates),
    blob_key: blobKey,
    blob_bytes: blobBytes,
    status: 'pending',
    actor_id: input.actorId ?? null,
  } as any).returning(['id']).executeTakeFirst()

  return {
    id: Number(row?.id ?? 0),
    repositoryId: input.repositoryId,
    sequence,
    updates,
    blobKey,
    blobBytes,
    status: 'pending',
  }
}

/** Stream a bundle of the pushed objects into the blob store. */
async function writeBundle(input: RecordPushInput, sequence: number): Promise<{ key: string, size: number } | null> {
  const args = bundleArgs(input.updates, input.excludeRefs ?? [])

  // `background`, with the other push-path work: a bundle is bounded by how
  // much the push brought, and a fleet pushing at once must not starve the
  // pages a person is reading.
  const child = await spawnGitLimited('background', input.repositoryPath, args, input.quarantine as Record<string, string> ?? {})

  if (!child)
    return null

  const timer = setTimeout(() => child.kill('SIGKILL'), BUNDLE_TIMEOUT_MS)

  try {
    const key = bundleKey(input.repositoryId, sequence)
    const store = await blobStore()

    // Streamed straight through: the bundle is never held in this process, and
    // the store decides how it is persisted.
    const written = await store.put(key, child.stdout as AsyncIterable<Uint8Array>)
    const code = await new Promise<number>(resolve => child.on('close', value => resolve(value ?? -1)))

    if (code !== 0 || written.size === 0) {
      // A bundle git refused to finish is not a bundle. Better no blob than
      // one that fails to verify on the day somebody restores from it.
      await store.delete(key).catch(() => undefined)

      return null
    }

    return { key, size: written.size }
  }
  catch {
    return null
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * The next sequence for a repository.
 *
 * Read-then-write, which is a race on paper and is closed by the unique index
 * on `(repository_id, sequence)`: the loser of a race gets a constraint
 * violation rather than a duplicate, and the caller retries. Phase 18c moves
 * this under the per-repo lock that the ref ledger needs anyway; until then
 * the index is the guarantee, and it is a real one.
 */
export async function nextSequence(repositoryId: number): Promise<number> {
  const highest: any = await db
    .selectFrom('git_wal_entries')
    .select(['sequence'])
    .where('repository_id', '=', repositoryId)
    .orderBy('sequence', 'desc')
    .limit(1)
    .executeTakeFirst()

  return Number(highest?.sequence ?? 0) + 1
}

/**
 * Commit the pending entry a landed push corresponds to.
 *
 * Matched on the ref updates rather than on an id, because the gate and the
 * post-receive hook are two separate requests with nothing carried between
 * them - git offers no handle that spans them. Matching on "the newest pending
 * entry for this repository whose updates are these" is exact for every real
 * push and, in the pathological case of the same push twice with nothing in
 * between, commits the older of two identical rows, which is the same outcome
 * either way.
 */
export async function commitLanded(gitDir: string, updates: readonly RefUpdate[]): Promise<void> {
  const { repositoryByGitDir } = await import('./hooks')
  const repository: any = await repositoryByGitDir(gitDir)

  if (!repository)
    return

  const wanted = JSON.stringify(walUpdatesFrom(updates))

  const pending: any = await db
    .selectFrom('git_wal_entries')
    .select(['id', 'updates'])
    .where('repository_id', '=', Number(repository.id))
    .where('status', '=', 'pending')
    .orderBy('sequence', 'asc')
    .execute()

  const match = (pending as any[]).find(row => String(row.updates) === wanted)

  if (match)
    await commitPush(Number(match.id))
}

/** Mark a recorded push as landed. */
export async function commitPush(entryId: number): Promise<void> {
  await db.updateTable('git_wal_entries')
    .set({ status: 'committed', committed_at: new Date().toISOString() } as any)
    .where('id', '=', entryId)
    .execute()
}

/**
 * Mark a recorded push as never having landed, with a reason.
 *
 * The bundle stays. A voided entry whose blob was deleted is a gap somebody
 * cannot investigate, and the checkpoint sweep is what reclaims the space
 * later, deliberately, rather than a refusal path doing it in a hurry.
 */
export async function voidPush(entryId: number, reason: string): Promise<void> {
  await db.updateTable('git_wal_entries')
    .set({ status: 'void', reason } as any)
    .where('id', '=', entryId)
    .execute()
}

/** The log for a repository, oldest first. */
export async function entriesFor(repositoryId: number, options: { throughSequence?: number } = {}): Promise<WalEntry[]> {
  let query = db
    .selectFrom('git_wal_entries')
    .select(['id', 'repository_id', 'sequence', 'updates', 'blob_key', 'blob_bytes', 'status'])
    .where('repository_id', '=', repositoryId)

  if (options.throughSequence !== undefined)
    query = query.where('sequence', '<=', options.throughSequence)

  const rows = await query.orderBy('sequence', 'asc').execute()

  return rows.map((row: any) => ({
    id: Number(row.id),
    repositoryId: Number(row.repository_id),
    sequence: Number(row.sequence),
    updates: parseUpdates(row.updates),
    blobKey: row.blob_key ? String(row.blob_key) : null,
    blobBytes: Number(row.blob_bytes ?? 0),
    status: String(row.status) as WalEntry['status'],
  }))
}

function parseUpdates(raw: unknown): WalRefUpdate[] {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'))

    return Array.isArray(parsed) ? parsed : []
  }
  catch {
    return []
  }
}

/**
 * Check a bundle is what it claims to be.
 *
 * `git bundle verify` reads the pack and the prerequisites, so this is the
 * difference between "the blob is there" and "the blob restores". A backup
 * nobody has verified is a hope.
 *
 * Needs a repository to verify *against*, because a bundle's prerequisites are
 * commits it does not contain.
 */
export async function verifyBundle(repositoryPath: string, bundlePath: string): Promise<{ ok: boolean, reason: string }> {
  const result = await runGit(repositoryPath, ['bundle', 'verify', bundlePath], {
    timeoutMs: 60_000,
    priority: 'background',
  })

  return { ok: result.ok, reason: result.ok ? '' : result.stderr.trim() }
}

/**
 * Replay a log into a repository: the ref updates, in order.
 *
 * The bundles have to be fetched first - this only moves refs, because the
 * objects arriving and the refs moving are two steps and conflating them is
 * how a replay half-succeeds. `buddy git:restore` drives both.
 */
export async function replay(repositoryPath: string, entries: readonly WalEntry[]): Promise<{ applied: number, failed: string[] }> {
  const failed: string[] = []
  let applied = 0

  for (const entry of entries) {
    if (entry.status === 'void')
      continue

    for (const update of entry.updates) {
      const deleting = /^0{40}$/.test(update.after)

      const result = deleting
        ? await runGit(repositoryPath, ['update-ref', '-d', update.ref], { priority: 'background' })
        : await runGit(repositoryPath, ['update-ref', update.ref, update.after], { priority: 'background' })

      if (result.ok)
        applied += 1
      else
        failed.push(`${entry.sequence} ${update.ref}: ${result.stderr.trim()}`)
    }
  }

  return { applied, failed }
}
