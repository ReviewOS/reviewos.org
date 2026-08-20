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

import { maxJobLogBytes } from '../../../config/ci-logs'
import { db } from '@stacksjs/database'
import { countRedactions, MARKER, redactSecrets } from './redact'
import type { LogEvent } from './logevents'
import { eventsAsText } from './logevents'
import { isNotFalse } from '../Support/sql'

/**
 * How much output one job may keep.
 *
 * Two megabytes is far more than a passing build writes and far less than a
 * loop printing to stderr can produce in a minute. It is a policy rather than a
 * law, which is why it now lives in `config/ci-logs.ts` - the correct value
 * depends entirely on the disk somebody bought - but a wrong ceiling is
 * recoverable and no ceiling is not.
 *
 * Read once, at module load, like every other setting in this codebase: a
 * ceiling re-read per append would be a configuration change that takes effect
 * halfway through a job's output.
 */
export const MAX_JOB_LOG_BYTES = maxJobLogBytes()

/** And no single append may be more than a slice of it. */
export const MAX_CHUNK_BYTES = 64 * 1024

export interface AppendInput {
  jobId: number
  /** The runner's own counter, from 1. */
  sequence: number
  content: string
  stream?: 'stdout' | 'stderr'
  /**
   * The same output as events, when the runner sent it that way.
   *
   * Stored beside the text rather than instead of it. `content` stays the
   * source of truth for everything that reads a log as text - the ceiling
   * arithmetic here, the API's plain answer, somebody with `curl` - and a
   * caller that sends events gets the text derived from them rather than having
   * to send both.
   */
  events?: readonly LogEvent[]
}

export interface AppendOutcome {
  ok: boolean
  /** True when this chunk was already stored: at-least-once, answered as done. */
  duplicate: boolean
  /** True once the job has said all it is going to be allowed to say. */
  truncated: boolean
  reason: string
  /** How long to wait before sending this chunk again, when it was refused. */
  retryAfterMs?: number
}

/** Bytes rather than characters: the ceiling is about disk, not about reading. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

async function storedBytes(jobId: number): Promise<number> {
  const rows = await db
    .selectFrom('workflow_job_logs')
    .select(['content'])
    .where('workflow_job_id', '=', jobId)
    // This attempt's budget, not the sum of every attempt's: a re-run of a job
    // that filled the ceiling would otherwise be silent from its first line.
    .where('attempt', '=', (await attemptOf(jobId)).attempt)
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

  // Events, when there are any, decide the text: a runner that sends structure
  // should not also have to send the flattened form and keep the two in step.
  const events = input.events && input.events.length > 0 ? input.events : null

  /*
   * Redacted here, before anything is written down.
   *
   * The runner masks what it was given, and that is the first line - the only
   * place a value can be removed before it crosses the wire. This is the
   * second, and it exists because the first is somebody else's program: a
   * runner that is old, patched or hostile is still one this instance accepts
   * logs from, and "we asked it to mask" is not a property of the stored log.
   */
  const text = redactSecrets(events ? eventsAsText(events) : input.content, await secretsOfJob(input.jobId))

  // Trimmed rather than refused: a runner that sends a large chunk has already
  // produced the output, and refusing it loses more than clipping it does.
  const content = byteLength(text) > MAX_CHUNK_BYTES
    ? `${text.slice(0, MAX_CHUNK_BYTES)}\n[chunk truncated]\n`
    : text

  /*
   * Backpressure, before anything is written.
   *
   * The ceiling below truncates at the *end*, which is a documented and
   * survivable loss. Dropping the middle is not: a log missing the part where
   * something went wrong is worse than a log that stops, because a reader
   * cannot tell it happened. So a job producing faster than this instance wants
   * to store is asked to wait and send the same chunk again, which slows the
   * job and keeps its output whole - the chunk is idempotent on
   * `(job, attempt, sequence)`, so a retry costs nothing.
   */
  const wait = await throttleFor(byteLength(text))

  if (wait > 0)
    return { ok: false, duplicate: false, truncated: false, reason: 'too fast', retryAfterMs: wait }

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

  const job = await attemptOf(input.jobId)

  try {
    await db
      .insertInto('workflow_job_logs')
      .values({
        workflow_job_id: input.jobId,
        repository_id: job.repositoryId,
        /*
         * Which attempt wrote this.
         *
         * Read from the job rather than sent by the runner: the runner knows
         * what it was handed, and a re-run bumps the row - so trusting the
         * message would let a stale worker file its output under the new
         * attempt. The read is one indexed lookup on a row this write already
         * depends on.
         */
        attempt: job.attempt,
        sequence: input.sequence,
        content: clipped,
        stream,
        /*
         * The structured form is stored only when the text survived whole.
         * Past the ceiling the two would disagree - the text clipped, the
         * events complete - and a screen reading events would show lines the
         * plain answer says were dropped.
         */
        events: events && clipped === text ? JSON.stringify(events) : null,
      })
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

/** A unique violation, in either engine's spelling. */
function isDuplicate(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message}` : String(error)
  const state = String((error as { sqlState?: unknown })?.sqlState ?? '')

  // Both engines: Postgres says 23505 and "duplicate key", MySQL says 23000
  // with errno 1062 and "Duplicate entry". A chunk arriving twice is the
  // expected case here, so the wrong spelling makes a retry look like a fault.
  return text.includes('23505')
    || state === '23505'
    || state === '23000'
    || Number((error as { errno?: unknown })?.errno) === 1062
    || text.toLowerCase().includes('duplicate key')
    || text.toLowerCase().includes('duplicate entry')
}

export interface LogPage {
  /** Chunks after the cursor, in the order the runner produced them. */
  chunks: Array<{ sequence: number, stream: string, content: string, events?: LogEvent[] }>
  /** Where to ask from next. Unchanged when there was nothing new. */
  cursor: number
  /**
   * What was taken out of this page, and what it was replaced with.
   *
   * Metadata rather than a silent omission: the chunks above already carry the
   * marker inline, and this says how many of them there are so a client can
   * render "2 values hidden" beside the log instead of leaving a reader to
   * spot the markers themselves. `count` is per page, because that is what the
   * client is showing.
   */
  redaction: { marker: string, count: number }
}

/**
 * The secret values this job was given, for redaction.
 *
 * Memoized per job, because a job's secrets do not change while it runs and
 * decrypting them on every chunk would put the instance's key work on the hot
 * path of a streaming log. The entry goes when the job's log stops arriving;
 * the cache is bounded so a busy instance cannot grow one entry per job it has
 * ever run.
 */
const secretMemo = new Map<number, { values: string[], at: number }>()

/** How long a memoized set is trusted. A job that outlives it simply re-reads. */
const MEMO_MS = 5 * 60_000

/** The most jobs to remember at once. Past this, the oldest entry goes. */
const MEMO_LIMIT = 200

export async function secretsOfJob(jobId: number): Promise<string[]> {
  const held = secretMemo.get(jobId)

  if (held && Date.now() - held.at < MEMO_MS)
    return held.values

  try {
    const row = await db
      .selectFrom('workflow_jobs')
      .innerJoin('workflow_runs', 'workflow_runs.id', '=', 'workflow_jobs.workflow_run_id')
      .select([
        'workflow_runs.repository_id as repository_id',
        'workflow_runs.trusted as trusted',
        'workflow_jobs.settings as settings',
        'workflow_jobs.approved_at as approved_at',
      ])
      .where('workflow_jobs.id', '=', jobId)
      .executeTakeFirst()

    if (!row)
      return []

    const { secretsForJob } = await import('../Workflow/secrets')
    const settings = readSettings(row.settings)

    const delivered = await secretsForJob({
      repositoryId: Number(row.repository_id),
      trusted: isNotFalse(row.trusted),
      environment: typeof settings.environment === 'string' ? settings.environment : null,
      approved: Boolean(row.approved_at),
      only: Array.isArray(settings.secrets) ? settings.secrets.map(String) : null,
    })

    const values = Object.values(delivered).map(String).filter(Boolean)

    if (secretMemo.size >= MEMO_LIMIT)
      secretMemo.delete([...secretMemo.keys()][0]!)

    secretMemo.set(jobId, { values, at: Date.now() })

    return values
  }
  catch {
    /*
     * Nothing redacted rather than nothing stored. A log this cannot check is
     * still the record of what a job did, and losing it would be a bigger hole
     * than the one this closes - the runner has already masked what it was
     * given.
     */
    return []
  }
}

/** A job's settings blob, or an empty one. */
function readSettings(settings: unknown): Record<string, any> {
  try {
    const parsed = JSON.parse(String(settings ?? '{}'))

    return parsed && typeof parsed === 'object' ? parsed : {}
  }
  catch {
    return {}
  }
}

/**
 * What this instance has written recently, for the rate check.
 *
 * A sliding second, in memory, across every job. Deliberately not a row: a
 * counter written on every chunk would put a write on the hot path of every
 * line, which is the thing this exists to protect. An instance that restarts
 * forgets, and the worst that costs is one second of unthrottled writing.
 *
 * **Instance-wide rather than per job**, because that is where the problem is.
 * One job is bounded by the per-job ceiling anyway; what makes every other
 * write on the box slow is forty jobs flooding at once.
 */
const window = { bytes: 0, since: 0 }

/**
 * The budget, from the instance's settings.
 *
 * Read on every chunk rather than cached here: `allSettings` already holds a
 * short cache that a write invalidates, and a second cache on top of it means a
 * change an operator makes does not take effect until two timers agree - which
 * is the sort of behaviour that gets diagnosed as "the setting does nothing".
 */
async function bytesPerSecond(): Promise<number> {
  try {
    const { numberSetting } = await import('../../Ops/settings')

    return Math.max(0, await numberSetting('log_bytes_per_second'))
  }
  catch {
    // A settings table this cannot read means no throttle rather than no logs:
    // refusing every chunk because a lookup failed would lose the output of
    // every job on the instance.
    return 0
  }
}

/** How long a runner should wait before sending this chunk again, or zero. */
async function throttleFor(bytes: number): Promise<number> {
  const limit = await bytesPerSecond()

  // Zero is off, which is what a single-team instance with a fast disk wants
  // and what this behaves as when the setting cannot be read.
  if (limit <= 0)
    return 0

  const now = Date.now()

  if (now - window.since >= 1000) {
    window.since = now
    window.bytes = bytes

    return 0
  }

  if (window.bytes + bytes <= limit) {
    window.bytes += bytes

    return 0
  }

  // Wait out the rest of this second and no longer: a runner that sleeps a
  // second per chunk turns backpressure into a stall.
  return Math.max(50, 1000 - (now - window.since))
}

/** Which attempt the job is on, for attributing a chunk to it. */
async function attemptOf(jobId: number): Promise<{ attempt: number, repositoryId: number | null }> {
  try {
    const row = await db
      .selectFrom('workflow_jobs')
      // The shard key comes along with the attempt because both are read from
      // the same row: a log chunk belongs to the job's repository, and the
      // runner API has no repository in hand to tell it so.
      .select(['attempt', 'repository_id'])
      .where('id', '=', jobId)
      .executeTakeFirst()

    return { attempt: Number(row?.attempt ?? 1) || 1, repositoryId: Number(row?.repository_id) || null }
  }
  catch {
    return { attempt: 1, repositoryId: null }
  }
}

/**
 * Read from where a reader got to.
 *
 * A cursor rather than an offset in bytes, because the unit a reader can act on
 * is a chunk that was actually stored - and a byte offset into a log that is
 * still being written is a number that means something different a second
 * later.
 */
export async function readLog(jobId: number, after = 0, limit = 200, attempt?: number): Promise<LogPage> {
  /*
   * One attempt's log, the current one unless a reader asks for another.
   *
   * Sequence numbers restart with each attempt, so a page that read them all
   * would interleave two runs of the same job into one nonsensical order. The
   * earlier attempt is still there - that is the whole point of keeping it -
   * and a reader who wants it names it.
   */
  const wanted = Number.isInteger(attempt) && Number(attempt) > 0 ? Number(attempt) : (await attemptOf(jobId)).attempt

  const rows = await db
    .selectFrom('workflow_job_logs')
    .select(['sequence', 'stream', 'content', 'events'])
    .where('workflow_job_id', '=', jobId)
    .where('attempt', '=', wanted)
    .where('sequence', '>', Number.isFinite(after) ? after : 0)
    .orderBy('sequence', 'asc')
    .limit(Math.min(Math.max(limit, 1), 500))
    .execute()

  const chunks = rows.map(row => ({
    sequence: Number(row.sequence),
    stream: String(row.stream ?? 'stdout'),
    content: String(row.content ?? ''),
    // Present only for the chunks a runner sent structured. A reader that does
    // not know about events sees the text and misses nothing it could have
    // used; one that does gets the groups, the timestamps and the colour,
    // which cannot be recovered from the text afterwards.
    ...(row.events ? { events: safeEvents(row.events) } : {}),
  }))

  return {
    chunks,
    cursor: rows.length > 0 ? Number(rows[rows.length - 1]?.sequence ?? 0) : (Number.isFinite(after) ? after : 0),
    /*
     * Counted over what is being sent, not over what was stored.
     *
     * The redaction happened on the way in, so this is reading the markers back
     * out of the text. That is the only count that is right for pages written
     * before it was recorded anywhere, and a client showing a page is asking
     * about that page.
     */
    redaction: { marker: MARKER, count: chunks.reduce((total, chunk) => total + countRedactions(chunk.content), 0) },
  }
}

/**
 * The stored events, or none.
 *
 * A row whose JSON will not parse is a row written by a version that is gone or
 * a database somebody edited, and the text beside it is still correct - so this
 * drops the structure rather than failing a read of the log.
 */
function safeEvents(stored: unknown): LogEvent[] {
  try {
    const parsed = JSON.parse(String(stored ?? ''))

    return Array.isArray(parsed) ? parsed as LogEvent[] : []
  }
  catch {
    return []
  }
}
