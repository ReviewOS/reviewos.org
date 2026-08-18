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

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { db } from '@stacksjs/database'
import {
  artifactName,
  artifactPath,
  digestOf,
  expiresAt,
  isOrphaned,
  withinCeilings,
} from './storage'

export interface StoreInput {
  runId: number
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

  const created = await db
    .insertInto('workflow_artifacts')
    .values({
      workflow_run_id: input.runId,
      workflow_job_id: input.jobId ?? null,
      name,
      digest,
      size_bytes: size,
      content_type: String(input.contentType ?? '').slice(0, 150) || 'application/octet-stream',
      expires_at: retention.at,
      runner_id: input.runnerId ? String(input.runnerId).slice(0, 100) : null,
    } as any)
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
async function writeBlob(digest: string, bytes: Uint8Array): Promise<{ ok: true } | { ok: false, reason: string }> {
  try {
    const path = artifactPath(digest)
    const file = Bun.file(path)

    if (await file.exists())
      return { ok: true }

    await mkdir(dirname(path), { recursive: true })
    await Bun.write(path, bytes)

    return { ok: true }
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
    .select(['id', 'digest'])
    .where('expires_at', '<', now.toISOString())
    .execute()

  if (expired.length === 0)
    return { removed: 0, blobs: 0 }

  let blobs = 0

  for (const row of expired) {
    await db.deleteFrom('workflow_artifacts').where('id', '=', Number(row.id)).execute()

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
      const path = artifactPath(String(row.digest))

      if (await Bun.file(path).exists()) {
        await Bun.$`rm -f ${path}`.quiet()
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
