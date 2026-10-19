/**
 * The runner's calls to the cache endpoints.
 *
 * Kept out of `localExecutor.ts` because that file is already the longest thing
 * here and because these two calls have a property the rest of it does not:
 * **every failure is survivable**. A restore that 500s, a save the network cut,
 * an instance with caching switched off - all of them mean the job installs its
 * dependencies the slow way, which is what it did before any of this existed.
 * So nothing in this file throws, and nothing it returns can fail a job.
 */

import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { packSnapshot, unpackSnapshot } from './snapshot'

/**
 * The largest snapshot an instance accepts when it does not say.
 *
 * Bun's default `maxRequestBodySize`, which a Stacks server does not raise: a
 * larger body is refused with a 413 before the save action ever reads it.
 */
export const DEFAULT_UPLOAD_LIMIT_BYTES = 128 * 1024 * 1024

/**
 * Keys whose snapshot was too large for the instance, on this machine.
 *
 * The same lockfile gives the same key, so a snapshot too large for one job of
 * a run is too large for every other job of it and of the runs after it. One
 * attempt per key per runner process, rather than one per job.
 */
const tooLargeKeys = new Map<string, string>()

/** What a restore did, for the log line and for the decision to save later. */
export interface RestoreOutcome {
  restored: boolean
  /** Which scope it came from, when one did. */
  scope?: string
  /** True when it came from this run's own scope rather than the default branch. */
  exact: boolean
  reason?: string
  /** The largest snapshot the instance says it accepts. */
  maxBytes?: number
}

function uploadLimitOf(answer: Response): number | undefined {
  const value = Number(answer.headers.get('x-cache-max-bytes'))

  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Fetch the snapshot this run may restore for a key, and unpack it.
 *
 * The archive lands beside the workspace rather than inside it: a file the job
 * can see is a file the job can read, and a snapshot restored from another
 * branch is not something a build should be able to inspect for what changed.
 */
export async function restoreCache(input: {
  baseUrl: string
  jobToken: string
  key: string
  workspace: string
  scratch: string
}): Promise<RestoreOutcome> {
  const archive = join(input.scratch, 'restore.tar.gz')

  try {
    const answer = await fetch(`${input.baseUrl}/api/runner/caches/restore`, {
      headers: {
        'Authorization': `Bearer ${input.jobToken}`,
        'X-Cache-Key': input.key,
        'X-Runner-Protocol': '1',
      },
    })

    // 204 is the ordinary answer on a repository that has not cached this key
    // yet, which is every repository once.
    const maxBytes = uploadLimitOf(answer)

    if (answer.status === 204)
      return { restored: false, exact: false, reason: 'nothing stored for this key', maxBytes }

    if (!answer.ok)
      return { restored: false, exact: false, reason: `the instance answered ${answer.status}`, maxBytes }

    await Bun.write(archive, answer)

    const unpacked = await unpackSnapshot(archive, input.workspace)

    if (!unpacked.ok)
      return { restored: false, exact: false, reason: unpacked.reason, maxBytes }

    return {
      restored: true,
      exact: answer.headers.get('x-cache-exact') === 'true',
      scope: answer.headers.get('x-cache-scope') ?? undefined,
      maxBytes,
    }
  }
  catch (error) {
    return { restored: false, exact: false, reason: error instanceof Error ? error.message : String(error) }
  }
  finally {
    // The archive is worth nothing once it is unpacked, and leaving a copy of
    // every dependency the job has beside the workspace is how a runner fills
    // its disk over an afternoon.
    try { unlinkSync(archive) }
    catch { /* it was never written */ }
  }
}

export interface SaveOutcome {
  saved: boolean
  sizeBytes?: number
  reason?: string
}

/** Pack the workspace and hand it to the instance, which decides whose cache it is. */
export async function saveCache(input: {
  baseUrl: string
  jobToken: string
  key: string
  workspace: string
  scratch: string
  /** What the instance accepts; the Bun default when it did not say. */
  maxBytes?: number
}): Promise<SaveOutcome> {
  const archive = join(input.scratch, 'save.tar.gz')
  const limit = input.maxBytes ?? DEFAULT_UPLOAD_LIMIT_BYTES
  const known = tooLargeKeys.get(input.key)

  if (known)
    return { saved: false, reason: `${known} (found by an earlier job on this runner, so not packed again)` }

  try {
    const packed = await packSnapshot(input.workspace, archive, limit)

    if (packed.tooLarge)
      tooLargeKeys.set(input.key, String(packed.reason))

    if (!packed.ok)
      return { saved: false, reason: packed.reason }

    const answer = await fetch(`${input.baseUrl}/api/runner/caches`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${input.jobToken}`,
        'Content-Type': 'application/octet-stream',
        'X-Cache-Key': input.key,
        'X-Cache-Digest': String(packed.digest),
        'X-Runner-Protocol': '1',
      },
      body: Bun.file(archive),
    })

    if (answer.status === 413)
      tooLargeKeys.set(input.key, `the instance refused ${Math.round(Number(packed.sizeBytes ?? 0) / 1024 / 1024)} MiB as too large`)

    if (!answer.ok)
      return { saved: false, reason: `the instance answered ${answer.status}` }

    return { saved: true, sizeBytes: packed.sizeBytes }
  }
  catch (error) {
    return { saved: false, reason: error instanceof Error ? error.message : String(error) }
  }
  finally {
    try { unlinkSync(archive) }
    catch { /* it was never written */ }
  }
}

/** Forget which keys were too large. For tests: a runner process never needs it. */
export function forgetTooLargeSnapshots(): void {
  tooLargeKeys.clear()
}
