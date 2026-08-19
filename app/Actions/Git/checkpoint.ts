/**
 * The full bundle that lets the log forget its beginning.
 *
 * A write-ahead log of every push is a complete history and an unbounded one:
 * a repository pushed to for three years holds three years of bundles, and
 * restoring means replaying all of them. A checkpoint is the fix and it is the
 * ordinary one - a full `git bundle create --all` written to the blob store,
 * after which every entry before it is redundant and can be pruned.
 *
 * ## The sequence in the key is the whole index
 *
 * `wal/<repository>/checkpoints/<sequence>.bundle`, zero-padded. There is no
 * checkpoints table: what a restore needs to know is "the newest checkpoint
 * and which entry it covers", and both are in that name. A table would be a
 * second thing to keep in step with the store, and the failure mode of the two
 * disagreeing is a restore that silently starts from the wrong place.
 *
 * ## Compaction runs on the primary only
 *
 * `git repack` before the bundle, per the reference architecture: replicas
 * trade bandwidth for CPU rather than each repacking the same objects. On one
 * box that distinction costs nothing and is worth writing down before there
 * are two.
 */

import type { BlobStore } from './blobs'
import { blobStore } from './blobs'
import { runGit } from './git'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '@stacksjs/database'

/** How long a full bundle of a large repository may take. */
const CHECKPOINT_TIMEOUT_MS = 30 * 60_000

/** Under this many bytes, git wrote a header and no pack. */
const BUNDLE_HEADER_BYTES = 32

/** Where a checkpoint covering everything through `sequence` lives. */
export function checkpointKey(repositoryId: number, sequence: number): string {
  return `wal/${repositoryId}/checkpoints/${String(sequence).padStart(12, '0')}.bundle`
}

/** The sequence a checkpoint key covers, or null when it is not one. */
export function checkpointSequence(key: string): number | null {
  const match = /\/checkpoints\/(\d{12})\.bundle$/.exec(key)

  return match ? Number(match[1]) : null
}

export interface Checkpoint {
  key: string
  sequence: number
  bytes: number
}

/**
 * The newest checkpoint for a repository.
 *
 * Read from the store rather than from a row, which also means a checkpoint
 * somebody copied into the bucket by hand is found - and, more usefully, that
 * a database restored from an older dump still discovers the checkpoints that
 * exist.
 */
export async function latestCheckpoint(repositoryId: number, store?: BlobStore): Promise<Checkpoint | null> {
  const blobs = store ?? await blobStore()
  const found = await blobs.list(`wal/${repositoryId}/checkpoints`).catch(() => [])

  let newest: Checkpoint | null = null

  for (const entry of found) {
    const sequence = checkpointSequence(entry.key)

    if (sequence === null)
      continue

    if (!newest || sequence > newest.sequence)
      newest = { key: entry.key, sequence, bytes: entry.size }
  }

  return newest
}

/**
 * Repack, then write a full bundle covering everything up to `sequence`.
 *
 * Returns null when there is nothing to bundle - an empty repository is a
 * legitimate state and not a failure, and writing a header-only blob for it
 * would put a checkpoint in the store that restores nothing.
 */
export async function writeCheckpoint(
  repositoryId: number,
  repositoryPath: string,
  sequence: number,
  options: { repack?: boolean } = {},
): Promise<Checkpoint | null> {
  if (options.repack !== false) {
    /*
     * Plain `gc`, the same as nightly maintenance and for the same reason: the
     * default two-week prune grace is the only coordination with a push
     * sitting between quarantine merge and ref update. A checkpoint is not a
     * reason to become less careful about that.
     */
    await runGit(repositoryPath, ['gc'], { timeoutMs: CHECKPOINT_TIMEOUT_MS, priority: 'background' })
  }

  /*
   * git writes the bundle to a file, not to a pipe.
   *
   * The pipe is what made this unreliable. Bun drops a child's buffered stdout
   * once the child exits with nobody reading it, so every gap between the spawn
   * and the first read is a chance to lose the whole bundle - and there is
   * always a gap. Resolving the store was one; the blob directory's first
   * `mkdir`, inside `put` and before it touches the stream, is another. That is
   * why this failed on CI on the first checkpoint of a run and never on the
   * second, and never at all on a laptop where those calls are quick.
   *
   * A file has no such window. It costs a temporary the size of the bundle,
   * which the store is about to hold anyway, and `git bundle create` is happier
   * writing something seekable than a pipe.
   */
  const key = checkpointKey(repositoryId, sequence)
  const store = await blobStore()
  const scratch = join(tmpdir(), `reviewos-checkpoint-${repositoryId}-${sequence}-${randomUUID()}.bundle`)

  try {
    const result = await runGit(repositoryPath, ['bundle', 'create', scratch, '--all'], {
      timeoutMs: CHECKPOINT_TIMEOUT_MS,
      priority: 'background',
    })

    if (!result.ok) {
      // An empty repository lands here legitimately: git refuses to write a
      // bundle with nothing in it. So do the real failures, which is why the
      // reason is logged rather than swallowed.
      console.warn(`[checkpoint] repository ${repositoryId}: git bundle failed at sequence ${sequence}: ${result.stderr.trim() || `exit ${result.code}`}`)

      return null
    }

    const file = Bun.file(scratch)
    const size = file.size

    if (size <= BUNDLE_HEADER_BYTES) {
      console.warn(`[checkpoint] repository ${repositoryId}: git wrote ${size} bytes, a header and no pack; no checkpoint at sequence ${sequence}`)

      return null
    }

    const written = await store.put(key, file.stream())

    return { key, sequence, bytes: written.size }
  }
  catch (error) {
    console.warn(`[checkpoint] repository ${repositoryId}: writing the bundle failed: ${error instanceof Error ? error.message : String(error)}`)

    return null
  }
  finally {
    await rm(scratch, { force: true }).catch(() => undefined)
  }
}

/**
 * Tell clients where the checkpoint is, so most of a clone comes from storage.
 *
 * `bundle-uri` is git's own answer to the clone storm phase 15 creates: a
 * client that understands it fetches the bundle over plain HTTP - from a
 * bucket, a CDN, or this instance - and then asks the server only for what has
 * landed since. The expensive half of a clone stops touching `upload-pack` at
 * all, and the client falls back silently if the bundle is unreachable, which
 * is what makes this safe to advertise rather than a second thing to keep up.
 *
 * Written into the repository's own config, so it is git advertising it rather
 * than this application intercepting anything.
 */
export async function advertiseBundle(repositoryPath: string, url: string): Promise<boolean> {
  const settings: Array<[string, string]> = [
    ['uploadpack.advertiseBundleURIs', 'true'],
    ['bundle.version', '1'],
    // `all` - the bundle carries every ref, which is what a checkpoint is.
    // `any` would tell the client one bundle is enough on its own.
    ['bundle.mode', 'all'],
    ['bundle.checkpoint.uri', url],
  ]

  for (const [key, value] of settings) {
    const written = await runGit(repositoryPath, ['config', key, value], { priority: 'background' })

    if (!written.ok)
      return false
  }

  return true
}

/**
 * Stop advertising, for a repository whose checkpoint has gone.
 *
 * An advertised URI that 404s costs every cloning client a wasted request
 * before it falls back, which is a slow clone rather than a broken one - but
 * it is a slow clone the operator cannot see the reason for.
 */
export async function withdrawBundle(repositoryPath: string): Promise<void> {
  await runGit(repositoryPath, ['config', '--unset', 'bundle.checkpoint.uri'], { priority: 'background' }).catch(() => undefined)
  await runGit(repositoryPath, ['config', 'uploadpack.advertiseBundleURIs', 'false'], { priority: 'background' }).catch(() => undefined)
}

export interface PruneOutcome {
  removedRows: number
  removedBlobs: number
}

/**
 * Drop the log prefix a checkpoint has made redundant.
 *
 * Two guards, and both exist because this deletes backup material:
 *
 * - only entries at or below the checkpoint's sequence, because anything after
 *   it is not covered by the checkpoint and is the only copy;
 * - only entries beyond `keepEntries`, so a restore to a point *between* two
 *   checkpoints is still possible for as far back as the operator asked.
 *
 * A `pending` entry is never pruned whatever its sequence. It is the one kind
 * the reconciler has not yet decided about, and deleting it would turn an open
 * question into a silent gap.
 */
export interface PrunableEntry {
  id: number
  sequence: number
  status: string
  blobKey: string | null
}

/**
 * Which entries a checkpoint has made redundant.
 *
 * Pure, and separated from the deleting for the reason the reconciler's rule
 * is: this decides what to destroy, and a rule that can only be exercised by
 * destroying something is a rule nobody tests.
 */
export function prunable(
  entries: readonly PrunableEntry[],
  throughSequence: number,
  keepEntries: number,
): PrunableEntry[] {
  const ceiling = throughSequence - Math.max(0, keepEntries)

  if (ceiling <= 0)
    return []

  return entries.filter(entry =>
    entry.sequence <= ceiling
    // Never a pending entry, whatever its sequence. It is the one kind the
    // reconciler has not decided about, and deleting it turns an open question
    // into a silent gap in the backup.
    && entry.status !== 'pending',
  )
}

export async function pruneThrough(repositoryId: number, sequence: number, keepEntries: number): Promise<PruneOutcome> {
  const outcome: PruneOutcome = { removedRows: 0, removedBlobs: 0 }

  const rows: any[] = await db
    .selectFrom('git_wal_entries')
    .select(['id', 'sequence', 'blob_key', 'status'])
    .where('repository_id', '=', repositoryId)
    .where('sequence', '<=', sequence)
    .execute()
    .catch(() => [])

  const doomed = prunable(
    rows.map(row => ({
      id: Number(row.id),
      sequence: Number(row.sequence),
      status: String(row.status),
      blobKey: row.blob_key ? String(row.blob_key) : null,
    })),
    sequence,
    keepEntries,
  )

  const store = await blobStore()

  for (const entry of doomed) {
    if (entry.blobKey) {
      await store.delete(entry.blobKey).catch(() => undefined)
      outcome.removedBlobs += 1
    }

    await db.deleteFrom('git_wal_entries').where('id', '=', entry.id).execute().catch(() => undefined)
    outcome.removedRows += 1
  }

  return outcome
}

/**
 * Older checkpoints, once a newer one exists.
 *
 * One is kept behind the newest, deliberately: a checkpoint is read at exactly
 * the moment somebody is recovering, which is the worst moment to discover
 * that the only copy is the one that failed to verify.
 */
export async function pruneCheckpoints(repositoryId: number): Promise<number> {
  const store = await blobStore()
  const found = await store.list(`wal/${repositoryId}/checkpoints`).catch(() => [])

  const sequences = found
    .map(entry => ({ entry, sequence: checkpointSequence(entry.key) }))
    .filter((item): item is { entry: typeof found[number], sequence: number } => item.sequence !== null)
    .sort((left, right) => right.sequence - left.sequence)

  let removed = 0

  for (const item of sequences.slice(2)) {
    await store.delete(item.entry.key).catch(() => undefined)
    removed += 1
  }

  return removed
}
