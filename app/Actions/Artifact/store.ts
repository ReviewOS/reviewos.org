/**
 * Taking bytes off a runner and turning them into something a person can fetch.
 *
 * The database half of `storage.ts`, kept apart from it so the rules - the
 * ceilings, the retention, the path - stay testable without a disk or a
 * connection.
 *
 * **Idempotent by name within a run.** At-least-once delivery is the protocol's
 * promise, so a runner that did not hear the answer uploads again; without a
 * rule the run grows two rows for one file and whoever collects it has to guess
 * which. The second upload of identical bytes is recognised and answered as a
 * duplicate. The second upload of *different* bytes under a name already taken
 * is refused, because silently replacing an artifact somebody may already have
 * downloaded is worse than making the job pick another name.
 */

import { db } from '@stacksjs/database'
import {
  artifactKey,
  artifactKeyFor,
  artifactName,
  digestOf,
  expiresAt,
  isOrphaned,
  withinCeilings,
} from './storage'

export interface StoreInput {
  runId: number
  /**
   * The shard key, when the caller already has it.
   *
   * Read from the run when it does not: an artifact belongs to a repository
   * whatever route it arrived by, and a row that is missing the key is a row
   * Vitess would have to scatter to find.
   */
  repositoryId?: number | null
  jobId?: number | null
  name: unknown
  bytes: Uint8Array
  contentType?: string | null
  /** What the uploader asked to keep it for. Clamped, never refused. */
  retentionDays?: number | null
  runnerId?: string | null
  now?: Date
}

export type StoreOutcome =
  | { ok: true, id: number, digest: string, size: number, expiresAt: string, duplicate: boolean }
  | { ok: false, reason: string, status: number }

/** Everything one run already holds, which the per-run ceiling is measured against. */
export async function runArtifactBytes(runId: number): Promise<number> {
  const rows = await db
    .selectFrom('workflow_artifacts')
    .select(['size_bytes'])
    .where('workflow_run_id', '=', runId)
    .execute()

  return rows.reduce((total, row) => total + (Number(row.size_bytes) || 0), 0)
}

export async function storeArtifact(input: StoreInput): Promise<StoreOutcome> {
  const name = artifactName(input.name)
  const size = input.bytes.byteLength

  const held = await runArtifactBytes(input.runId)
  const room = withinCeilings(size, held)

  if (!room.ok)
    return { ok: false, reason: room.reason, status: 413 }

  const digest = digestOf(input.bytes)

  /*
   * The name is checked before the bytes are written.
   *
   * Two uploads of the same name and the same content are one artifact and the
   * second is a duplicate; two of the same name and *different* content is a
   * mistake somebody has to fix, because replacing an artifact a person may
   * already hold means two people have different files with one name and no way
   * to tell.
   */
  const existing = await db
    .selectFrom('workflow_artifacts')
    .select(['id', 'digest', 'size_bytes', 'expires_at'])
    .where('workflow_run_id', '=', input.runId)
    .where('name', '=', name)
    .executeTakeFirst()

  if (existing) {
    if (String(existing.digest) === digest) {
      return {
        ok: true,
        id: Number(existing.id),
        digest,
        size: Number(existing.size_bytes) || size,
        expiresAt: String(existing.expires_at ?? ''),
        duplicate: true,
      }
    }

    return {
      ok: false,
      reason: `This run already has an artifact called ${name}, with different content. Upload it under another name.`,
      status: 409,
    }
  }

  const written = await writeBlob(digest, input.bytes)

  if (!written.ok)
    return { ok: false, reason: written.reason, status: 500 }

  const retention = expiresAt({ requestedDays: input.retentionDays ?? null, now: input.now })

  const repositoryId = input.repositoryId ?? (Number((await db
    .selectFrom('workflow_runs')
    .select(['repository_id'])
    .where('id', '=', input.runId)
    .executeTakeFirst())?.repository_id ?? 0) || null)

  const created = await db
    .insertInto('workflow_artifacts')
    .values({
      workflow_run_id: input.runId,
      repository_id: repositoryId,
      workflow_job_id: input.jobId ?? null,
      name,
      digest,
      blob_key: written.key,
      size_bytes: size,
      content_type: String(input.contentType ?? '').slice(0, 150) || 'application/octet-stream',
      expires_at: retention.at,
      runner_id: input.runnerId ? String(input.runnerId).slice(0, 100) : null,
    })
    .returning(['id'])
    .executeTakeFirst()

  return {
    ok: true,
    id: Number(created?.id),
    digest,
    size,
    expiresAt: retention.at,
    duplicate: false,
  }
}

/**
 * Put the bytes on disk, unless they are already there.
 *
 * Content addressing means "already there" is the ordinary case on any instance
 * that runs a matrix, and re-writing a file whose name is its own digest can
 * only ever write the same bytes - so the check is a saving rather than a
 * correctness rule. Correctness comes from the name: two writers racing write
 * identical content to the same path.
 */
async function writeBlob(digest: string, bytes: Uint8Array): Promise<{ ok: true, key: string } | { ok: false, reason: string }> {
  const key = artifactKey(digest)

  try {
    const { blobStore } = await import('../Git/blobs')
    const store = await blobStore()

    // Content addressing means an existing blob is byte-identical to this one,
    // so the check is a saving rather than a correctness rule - and `stat`
    // asks the store rather than the filesystem, which is what lets the same
    // saving apply when the store is a bucket.
    if (await store.stat(key))
      return { ok: true, key }

    await store.put(key, bytes)

    return { ok: true, key }
  }
  catch (error) {
    return { ok: false, reason: `The artifact could not be stored: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Remove the artifacts whose time is up, and the blobs nothing else references.
 *
 * The row goes first and the file second, deliberately. A row without a file is
 * a download that 404s, which is unpleasant; a file without a row is a byte
 * nobody can reach and nobody will ever delete, which is a disk that fills for
 * reasons an operator cannot see.
 */
export async function sweepExpiredArtifacts(now: Date = new Date()): Promise<{ removed: number, blobs: number }> {
  const expired = await db
    .selectFrom('workflow_artifacts')
    // `blob_key` too: the sweep deletes by the key the row recorded, falling
    // back to the derived one for rows written before the column existed.
    //
    // And the facts a receiver needs, read before the delete for the obvious
    // reason: the row is the only place they exist, and afterwards there is
    // nothing to describe what went.
    .select(['id', 'digest', 'blob_key', 'name', 'size_bytes', 'workflow_run_id', 'repository_id', 'expires_at'])
    .where('expires_at', '<', now.toISOString())
    .execute()

  if (expired.length === 0)
    return { removed: 0, blobs: 0 }

  let blobs = 0

  for (const row of expired) {
    await db.deleteFrom('workflow_artifacts').where('id', '=', Number(row.id)).execute()

    /*
     * Said out loud, after the delete.
     *
     * This is the one disappearance in the product that is otherwise silent: a
     * system that fetched a build output nightly starts fetching a 404, and the
     * first person to find out is whoever needed the file. The retention date
     * was on every listing, but a promise made three weeks ago is not a
     * notification.
     */
    await announceExpiry(row).catch(() => null)

    // Content addressing means one file backs many rows, so the blob goes only
    // when the last row that pointed at it does - otherwise expiring one run's
    // copy takes the artifact out from under every other run that produced
    // identical bytes.
    const remaining = await db
      .selectFrom('workflow_artifacts')
      .select(['id'])
      .where('digest', '=', String(row.digest))
      .limit(1)
      .execute()

    if (!isOrphaned(remaining.length))
      continue

    try {
      const { blobStore } = await import('../Git/blobs')
      const store = await blobStore()
      const key = artifactKeyFor(row)

      if (await store.stat(key)) {
        await store.delete(key)
        blobs += 1
      }
    }
    catch {
      // A blob that could not be removed is a byte on disk, not a broken
      // promise: the row is gone, so nothing can reach it, and the next sweep
      // will not see it either. Reported by the caller's own accounting rather
      // than by failing a sweep that did most of its work.
    }
  }

  return { removed: expired.length, blobs }
}

/** Tell the programs that were watching that an artifact has gone. */
async function announceExpiry(row: any): Promise<void> {
  const repositoryId = Number(row.repository_id ?? 0)

  if (!repositoryId)
    return

  const run: any = await db
    .selectFrom('workflow_runs')
    .select(['id', 'number'])
    .where('id', '=', Number(row.workflow_run_id ?? 0))
    .executeTakeFirst()
    .catch(() => null)

  const { announceArtifactExpired } = await import('../Workflow/announce')

  await announceArtifactExpired(repositoryId, {
    id: Number(row.id),
    name: String(row.name ?? ''),
    size: Number(row.size_bytes ?? 0) || 0,
    runId: Number(row.workflow_run_id ?? 0),
    runNumber: Number(run?.number ?? 0) || 0,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
  })
}
