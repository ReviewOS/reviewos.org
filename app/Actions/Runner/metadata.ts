/**
 * Values a run's jobs pass to each other.
 *
 * Buildkite's meta-data. A job that computes a version number, a preview URL or
 * a decision has to hand it to a job that runs later, and both alternatives are
 * worse: an artifact is a file for a string, and an output only reaches jobs
 * that declared `needs:` on the one that produced it - so a value cannot travel
 * sideways, or skip a layer, or reach a job that was generated after the fact.
 *
 * **Compare-and-set is the whole design.** Without it two parallel jobs each
 * read a list, each append their own entry, and each write the list back: the
 * second write lands on top of the first and one job's contribution is gone,
 * with nothing anywhere saying so. A refused write is a job that can retry; a
 * lost write is a build that is quietly missing something.
 */

import { db } from '@stacksjs/database'

/** How long a value may be. Beyond this it is a file, and files are artifacts. */
export const MAX_VALUE_BYTES = 10_000

export interface MetadataEntry {
  key: string
  value: string
  /** How many times this key has been written. What a compare-and-set compares. */
  version: number
}

export interface WriteOutcome {
  ok: boolean
  entry?: MetadataEntry
  /** The value that is actually there, when a compare-and-set was refused. */
  current?: MetadataEntry | null
  error?: string
  status?: number
}

/** Everything this run has been told, in key order. */
export async function listMetadata(runId: number): Promise<MetadataEntry[]> {
  const rows = await db
    .selectFrom('run_metadata')
    .select(['key', 'value', 'version'])
    .where('workflow_run_id', '=', runId)
    .orderBy('key')
    .execute()

  return rows.map(row => ({ key: String(row.key), value: String(row.value ?? ''), version: Number(row.version ?? 1) }))
}

/** One key, or null when nobody has set it. */
export async function readMetadata(runId: number, key: string): Promise<MetadataEntry | null> {
  const row = await db
    .selectFrom('run_metadata')
    .select(['key', 'value', 'version'])
    .where('workflow_run_id', '=', runId)
    .where('key', '=', key)
    .executeTakeFirst()

  return row ? { key: String(row.key), value: String(row.value ?? ''), version: Number(row.version ?? 1) } : null
}

/**
 * Set a key, optionally only if it still holds what the caller last saw.
 *
 * `expectedVersion` is the compare half: `0` means "only if nobody has set this
 * yet", a number means "only if it is still the version I read", and leaving it
 * out means an unconditional write, which is right for a job that owns a key
 * nobody else touches.
 *
 * The guard is in the `WHERE` clause rather than in a read followed by a write.
 * Two jobs writing in the same instant would both pass a look-then-write, and
 * the second would land on a value it never saw - which is exactly the failure
 * this exists to prevent, so it cannot be checked in application code.
 */
export async function writeMetadata(input: {
  runId: number
  key: string
  value: string
  jobId?: number | null
  expectedVersion?: number | null
}): Promise<WriteOutcome> {
  const key = String(input.key ?? '').trim()

  if (!key)
    return { ok: false, error: 'A key is required', status: 422 }

  if (Buffer.byteLength(String(input.value ?? ''), 'utf8') > MAX_VALUE_BYTES) {
    return {
      ok: false,
      // Named rather than truncated: a version number silently cut in half is a
      // deploy that ships the wrong thing.
      error: `A value may be up to ${MAX_VALUE_BYTES} bytes. Anything larger is a file, and a file is an artifact.`,
      status: 413,
    }
  }

  const value = String(input.value ?? '')
  const existing = await readMetadata(input.runId, key)
  const expected = input.expectedVersion

  if (typeof expected === 'number') {
    if (expected === 0 && existing)
      return { ok: false, current: existing, error: 'This key already has a value.', status: 409 }

    if (expected > 0 && (!existing || existing.version !== expected)) {
      return {
        ok: false,
        current: existing,
        // The current value comes back with the refusal, so a job can merge and
        // try again rather than read, guess, and race a second time.
        error: existing
          ? `This key is at version ${existing.version}, not ${expected}.`
          : 'This key has no value yet.',
        status: 409,
      }
    }
  }

  if (!existing) {
    try {
      await db
        .insertInto('run_metadata')
        .values({
          workflow_run_id: input.runId,
          key,
          value,
          version: 1,
          updated_by_job_id: input.jobId ?? null,
        })
        .execute()

      return { ok: true, entry: { key, value, version: 1 } }
    }
    catch {
      /*
       * Somebody inserted the same key between the read above and this write.
       * The unique index caught it, which is the point of having one - and a
       * caller who asked for a compare-and-set gets the refusal they asked for
       * rather than a value silently overwritten.
       */
      const now = await readMetadata(input.runId, key)

      if (typeof expected === 'number')
        return { ok: false, current: now, error: 'Another job set this key first.', status: 409 }

      return writeMetadata({ ...input, expectedVersion: null })
    }
  }

  const next = existing.version + 1

  const result = await db
    .updateTable('run_metadata')
    .set({ value, version: next, updated_by_job_id: input.jobId ?? null })
    .where('workflow_run_id', '=', input.runId)
    .where('key', '=', key)
    // Guarded on the version read above, which is what makes this a
    // compare-and-set rather than a hope.
    .where('version', '=', existing.version)
    .execute()

  if (changed(result))
    return { ok: true, entry: { key, value, version: next } }

  const now = await readMetadata(input.runId, key)

  return { ok: false, current: now, error: 'Another job wrote this key first.', status: 409 }
}

/**
 * Whether an update touched a row.
 *
 * The same care the claim takes: this driver answers with a plain number, and
 * treating an unknown answer as success would turn a refused compare-and-set
 * into a silent overwrite - the one outcome this module exists to prevent.
 */
function changed(result: any): boolean {
  if (typeof result === 'number')
    return result > 0

  const count = result?.numUpdatedRows ?? result?.rowCount ?? result?.changes

  return typeof count === 'bigint' ? count > 0n : Number(count ?? 0) > 0
}
