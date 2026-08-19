/**
 * Saving a workspace snapshot, and finding one to restore.
 *
 * The control plane's half of dependency caching. The runner makes the archive
 * and unpacks it; everything about *which* archive - the key, the scope a run
 * may write, the scopes it may read, whether an entry is fresh enough to be
 * worth a download - is decided here, on the instance, because a runner is
 * somebody else's program and the scope rules are a security boundary rather
 * than an optimisation.
 *
 * The bytes go through the phase 18 blob store, which means a snapshot is on
 * object storage wherever this instance keeps everything else, and two branches
 * whose lockfiles agree cost one file rather than two.
 */

import { db } from '@stacksjs/database'
import { blobStore } from '../Git/blobs'
import { canRestore, canSave, readableScopes, writableScope } from './cacheScope'
import type { RunFacts } from './cacheScope'

/**
 * How big a snapshot may be.
 *
 * Two gigabytes is far more than an install of anything reasonable and is also
 * where `size_bytes` stops fitting the column - the two coinciding is
 * convenient rather than a coincidence worth relying on, so the check is here
 * as well as implied there.
 *
 * The reason for a ceiling at all is that a cache stops paying above some size:
 * downloading and unpacking three gigabytes over a network is slower than
 * installing from a registry, so a workflow that hits this is one the cache was
 * making worse.
 */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024 * 1024

/** Where a snapshot's bytes live. Content-addressed, so identical installs share one file. */
export function snapshotBlobKey(repositoryId: number, digest: string): string {
  const clean = String(digest ?? '').toLowerCase()

  return `caches/${repositoryId}/${clean.slice(0, 2)}/${clean.slice(2, 4)}/${clean}`
}

export interface RestoreHit {
  id: number
  /** Which scope it actually came from: the run's own, or the default branch. */
  scope: string
  cacheKey: string
  digest: string
  blobKey: string
  sizeBytes: number
  /** True when it came from the run's own scope rather than the fallback. */
  exact: boolean
}

/**
 * The best entry a run may restore for a key, or nothing.
 *
 * "Best" is the run's own scope before the default branch's, and the order
 * comes from `readableScopes` rather than from a sort here - so there is one
 * place that decides what a run may read, and it is the place that also
 * refuses.
 */
export async function findRestorable(
  repositoryId: number,
  facts: RunFacts,
  cacheKey: string,
): Promise<RestoreHit | null> {
  const scopes = readableScopes(facts)

  for (const scope of scopes) {
    const row: any = await db
      .selectFrom('workflow_cache_entries')
      .select(['id', 'scope', 'cache_key', 'digest', 'blob_key', 'size_bytes'])
      .where('repository_id', '=', repositoryId)
      .where('scope', '=', scope)
      .where('cache_key', '=', String(cacheKey))
      .executeTakeFirst()
      .catch(() => null)

    if (!row)
      continue

    /*
     * Checked again, against the row that was actually found.
     *
     * The loop only asks for scopes the run may read, so this can only fail if
     * the two disagree - which is exactly the bug worth catching, because the
     * failure mode is a protected branch restoring a fork's bytes and nothing
     * anywhere saying so.
     */
    if (!canRestore(facts, String(row.scope)))
      continue

    return {
      id: Number(row.id),
      scope: String(row.scope),
      cacheKey: String(row.cache_key),
      digest: String(row.digest),
      blobKey: String(row.blob_key ?? snapshotBlobKey(repositoryId, String(row.digest))),
      sizeBytes: Number(row.size_bytes ?? 0),
      exact: String(row.scope) === scopes[0],
    }
  }

  return null
}

/** Record that an entry was restored, for the collector and for the run view. */
export async function markRestored(id: number): Promise<void> {
  const row: any = await db
    .selectFrom('workflow_cache_entries')
    .select(['restores'])
    .where('id', '=', id)
    .executeTakeFirst()
    .catch(() => null)

  await db
    .updateTable('workflow_cache_entries')
    .set({ last_used_at: new Date().toISOString(), restores: Number(row?.restores ?? 0) + 1 })
    .where('id', '=', id)
    .execute()
    .catch(() => null)
}

export interface SaveInput {
  repositoryId: number
  facts: RunFacts
  cacheKey: string
  digest: string
  sizeBytes: number
  body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>
  workflowRunId?: number | null
  /** The scope the runner believes it has, checked rather than believed. */
  claimedScope?: string | null
}

export interface SaveOutcome {
  ok: boolean
  reason: string
  /** True when an entry for this scope and key was already there. */
  duplicate: boolean
  scope?: string
}

/**
 * Store a snapshot for the scope the run is actually entitled to.
 *
 * The runner may name a scope and it is not believed: the answer comes from the
 * run row on this instance, and a runner asking for anything else is refused.
 * That refusal is the whole security boundary, so it happens before the bytes
 * are read rather than after they are stored.
 */
export async function saveSnapshot(input: SaveInput): Promise<SaveOutcome> {
  const scope = writableScope(input.facts)

  if (input.claimedScope && !canSave(input.facts, input.claimedScope))
    return { ok: false, duplicate: false, reason: `this run may only write to ${scope}` }

  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0)
    return { ok: false, duplicate: false, reason: 'a snapshot needs a size' }

  if (input.sizeBytes > MAX_SNAPSHOT_BYTES)
    return { ok: false, duplicate: false, reason: `a snapshot may not exceed ${MAX_SNAPSHOT_BYTES} bytes` }

  if (!/^[0-9a-f]{64}$/.test(String(input.digest)))
    return { ok: false, duplicate: false, reason: 'a snapshot is addressed by its sha-256' }

  const existing: any = await db
    .selectFrom('workflow_cache_entries')
    .select(['id'])
    .where('repository_id', '=', input.repositoryId)
    .where('scope', '=', scope)
    .where('cache_key', '=', String(input.cacheKey))
    .executeTakeFirst()
    .catch(() => null)

  /*
   * Already there, and answered as done.
   *
   * Delivery is at-least-once, so a runner that did not hear the answer sends
   * the snapshot again - and the second upload is the same bytes under the same
   * key. Treating it as a conflict would make a correct runner retry forever;
   * overwriting would spend the transfer to reach the state it is already in.
   */
  if (existing)
    return { ok: true, duplicate: true, reason: 'already stored', scope }

  const store = await blobStore()
  const key = snapshotBlobKey(input.repositoryId, input.digest)

  /*
   * The bytes first, the row second.
   *
   * That order leaves a snapshot in the store that no row points at when this
   * dies in between - which the collector removes as unreferenced. The other
   * order leaves a row pointing at nothing, which is a restore that fails on a
   * machine somebody is waiting for.
   */
  const already = await store.stat(key).catch(() => null)

  if (!already)
    await store.put(key, input.body as any)

  try {
    await db
      .insertInto('workflow_cache_entries')
      .values({
        repository_id: input.repositoryId,
        scope,
        cache_key: String(input.cacheKey),
        digest: String(input.digest),
        blob_key: key,
        size_bytes: Math.round(input.sizeBytes),
        last_used_at: new Date().toISOString(),
        restores: 0,
        workflow_run_id: input.workflowRunId ?? null,
      })
      .execute()
  }
  catch (error) {
    // Two runs of the same branch finishing their install together is ordinary,
    // and the unique index is what makes the race harmless rather than a check
    // both of them passed.
    if (String((error as any)?.message ?? '').match(/duplicate|unique/i))
      return { ok: true, duplicate: true, reason: 'stored by another run first', scope }

    throw error
  }

  return { ok: true, duplicate: false, reason: 'stored', scope }
}
