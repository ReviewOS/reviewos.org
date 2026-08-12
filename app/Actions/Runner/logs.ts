/**
 * A job's output: taking it in, and giving it back.
 *
 * The bytes come from a machine executing hostile code, so the only safe
 * assumptions are that there may be no end to them and that anything inside
 * them is text somebody chose. Both are handled here rather than at the edge,
 * because the edge is an HTTP action and this rule has to hold for every future
 * caller of it.
 *
 * **The ceiling is per job and enforced on the way in.** A runner that streams
 * forever is not stopped by a retention policy that runs tomorrow: it fills the
 * disk tonight. Past the ceiling the append is accepted and discarded, with one
 * line recorded saying so - refusing it would make a correct runner retry a
 * chunk that will never be wanted, which is worse than dropping it.
 */

import { db } from '@stacksjs/database'

/**
 * How much output one job may keep.
 *
 * Two megabytes is far more than a passing build writes and far less than a
 * loop printing to stderr can produce in a minute. It is a policy rather than a
 * law - the number belongs in configuration eventually - but a wrong ceiling is
 * recoverable and no ceiling is not.
 */
export const MAX_JOB_LOG_BYTES = 2 * 1024 * 1024

/** And no single append may be more than a slice of it. */
export const MAX_CHUNK_BYTES = 64 * 1024

export interface AppendInput {
  jobId: number
  /** The runner's own counter, from 1. */
  sequence: number
  content: string
  stream?: 'stdout' | 'stderr'
}

export interface AppendOutcome {
  ok: boolean
  /** True when this chunk was already stored: at-least-once, answered as done. */
  duplicate: boolean
  /** True once the job has said all it is going to be allowed to say. */
  truncated: boolean
  reason: string
}

/** Bytes rather than characters: the ceiling is about disk, not about reading. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

async function storedBytes(jobId: number): Promise<number> {
  const rows: any[] = await db
    .selectFrom('workflow_job_logs')
    .select(['content'])
    .where('workflow_job_id', '=', jobId)
    .execute()

  return rows.reduce((total, row) => total + byteLength(String(row.content ?? '')), 0)
}

/**
 * Store one chunk.
 *
 * Idempotent on `(job, sequence)`, which is a unique index rather than a check:
 * two deliveries of the same chunk arriving together would both pass a look and
 * both insert.
 */
export async function appendLog(input: AppendInput): Promise<AppendOutcome> {
  const stream = input.stream === 'stderr' ? 'stderr' : 'stdout'

  if (!Number.isInteger(input.sequence) || input.sequence < 1)
    return { ok: false, duplicate: false, truncated: false, reason: 'a sequence number from 1 is required' }

  // Trimmed rather than refused: a runner that sends a large chunk has already
  // produced the output, and refusing it loses more than clipping it does.
  const content = byteLength(input.content) > MAX_CHUNK_BYTES
    ? `${input.content.slice(0, MAX_CHUNK_BYTES)}\n[chunk truncated]\n`
    : input.content

  const already = await storedBytes(input.jobId)

  if (already >= MAX_JOB_LOG_BYTES) {
    // Accepted and dropped. Refusing would make a correct runner retry a chunk
    // that will never be wanted.
    return { ok: true, duplicate: false, truncated: true, reason: 'this job has reached its log ceiling' }
  }

  const room = MAX_JOB_LOG_BYTES - already
  const clipped = byteLength(content) > room
    ? `${content.slice(0, room)}\n[log truncated: this job reached ${MAX_JOB_LOG_BYTES} bytes]\n`
    : content

  try {
    await db
      .insertInto('workflow_job_logs')
      .values({
        workflow_job_id: input.jobId,
        sequence: input.sequence,
        content: clipped,
        stream,
      } as any)
      .execute()
  }
  catch (error) {
    if (isDuplicate(error))
      return { ok: true, duplicate: true, truncated: false, reason: 'already stored' }

    throw error
  }

  return {
    ok: true,
    duplicate: false,
    truncated: clipped !== content,
    reason: 'stored',
  }
}

/** Postgres says 23505 for a unique violation; drivers wrap it differently. */
function isDuplicate(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message}` : String(error)
  return text.includes('23505') || text.toLowerCase().includes('duplicate key')
}

export interface LogPage {
  /** Chunks after the cursor, in the order the runner produced them. */
  chunks: Array<{ sequence: number, stream: string, content: string }>
  /** Where to ask from next. Unchanged when there was nothing new. */
  cursor: number
}

/**
 * Read from where a reader got to.
 *
 * A cursor rather than an offset in bytes, because the unit a reader can act on
 * is a chunk that was actually stored - and a byte offset into a log that is
 * still being written is a number that means something different a second
 * later.
 */
export async function readLog(jobId: number, after = 0, limit = 200): Promise<LogPage> {
  const rows: any[] = await db
    .selectFrom('workflow_job_logs')
    .select(['sequence', 'stream', 'content'])
    .where('workflow_job_id', '=', jobId)
    .where('sequence', '>', Number.isFinite(after) ? after : 0)
    .orderBy('sequence', 'asc')
    .limit(Math.min(Math.max(limit, 1), 500))
    .execute()

  return {
    chunks: rows.map(row => ({
      sequence: Number(row.sequence),
      stream: String(row.stream ?? 'stdout'),
      content: String(row.content ?? ''),
    })),
    cursor: rows.length > 0 ? Number(rows[rows.length - 1].sequence) : (Number.isFinite(after) ? after : 0),
  }
}
