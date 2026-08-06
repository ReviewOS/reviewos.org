/**
 * Tokenizing on other threads, and remembering what has been tokenized.
 *
 * Worth stating plainly where this diverges from the plan it came from, because
 * the divergence follows from an architecture decision made earlier and not
 * from an oversight.
 *
 * The roadmap's worker pool is Pierre's: the *browser* tokenizes, because a
 * static site with no backend has no other machine. Ours cannot be that. Phase
 * 2 settled that the client does not download a highlighter, and the diff
 * engine settled that the server renders rows to HTML - so by the time markup
 * reaches a browser it is already coloured, and a browser-side pool would have
 * nothing to do.
 *
 * The thread that actually needs relieving is the server's. `streamManifest`
 * awaits highlighting per file, serially, on the event loop: while a large
 * compare is being rendered, every other request on the process waits behind
 * it. That is the same problem the roadmap describes, one machine to the left,
 * and this is the same answer applied there.
 *
 * Two things make it pay:
 *
 * - **Parallelism.** Highlighting is pure CPU and a laptop has eight cores.
 * - **Yielding.** Even with one worker the event loop is free while it runs,
 *   so a page load during a large compare is answered instead of queued.
 *
 * And one thing stops it being a blanket win: a round trip costs more than
 * tokenizing a short file, so short files stay in process. The threshold is
 * measured rather than guessed - see `scripts/benchmarks/diff-engine.ts`.
 */

import type { FlatToken, FlatTokenLines, WorkerResponse } from 'ts-syntax-highlighter'
import { unpackLines } from 'ts-syntax-highlighter'

/**
 * How much work is worth another thread.
 *
 * Below this, the message hop and the structured clone cost more than the
 * tokenizing does, and the pool would make a fifteen file pull request slower
 * to serve while looking busy. Characters rather than lines, because one
 * minified line is more work than four hundred short ones.
 */
export const WORKER_THRESHOLD_CHARS = 12_000

/**
 * How many workers, at most.
 *
 * One per core less two - one for the event loop, one for everything else the
 * machine is doing - and never more than eight, because past that the gain is
 * small and each worker is a copy of every grammar in memory.
 */
export function poolSize(cores: number): number {
  if (!Number.isFinite(cores) || cores < 3)
    return 1

  return Math.min(8, cores - 2)
}

export interface PoolStats {
  /** Workers started. Zero until the first request over the threshold. */
  workers: number
  /** Requests handed to a worker. */
  dispatched: number
  /** Requests answered from the cache instead. */
  cached: number
  /** Requests that never reached a worker because they were too small. */
  inline: number
  /** Requests dropped before a worker started on them. */
  cancelled: number
  /** Requests waiting for a free worker. */
  queued: number
  /** Requests a worker is working on now. */
  active: number
  /** Entries held in the result cache. */
  cacheSize: number
}

const stats: PoolStats = {
  workers: 0,
  dispatched: 0,
  cached: 0,
  inline: 0,
  cancelled: 0,
  queued: 0,
  active: 0,
  cacheSize: 0,
}

/** What the pool has been doing. For the benchmark harness and a debug page. */
export function poolStats(): PoolStats {
  return { ...stats, queued: pending.length, active: busy.size, cacheSize: cache.size }
}

interface Job {
  id: number
  language: string
  lines: readonly string[]
  resolve: (tokens: FlatToken[][] | null) => void
  cancelled: boolean
  timer?: ReturnType<typeof setTimeout>
}

/**
 * How long a worker gets before the caller stops waiting for it.
 *
 * Not a limit on how long tokenizing may take - it is a limit on how long a
 * *request* waits on something it cannot see. A worker that has wedged, or one
 * that died in a way that produced no error event, would otherwise hold a page
 * load open indefinitely. On timeout the answer is null, which every caller
 * already handles as "do it in process", so the reader gets their page slightly
 * later rather than not at all.
 */
const WORKER_TIMEOUT_MS = 10_000

interface PooledWorker {
  worker: Worker
  job: Job | null
}

let workers: PooledWorker[] | null = null
const pending: Job[] = []
const busy = new Map<number, PooledWorker>()
let nextId = 1

/**
 * How many workers this machine is allowed, worked out once.
 *
 * Null before the first request, and zero when workers are not available at
 * all - in which case every caller does its own tokenizing and nothing else
 * changes.
 */
let capacity: number | null = null
let available = true

/**
 * How a worker is opened, behind a seam.
 *
 * The seam earns its keep rather than existing for tidiness. Everything
 * interesting about this pool is what it does when a worker *misbehaves* - dies
 * mid-job, wedges, answers after its caller has gone - and none of those can be
 * provoked from a test with a real worker, which is well-behaved by
 * construction. Failure handling that is never exercised is failure handling
 * that does not work, and the retire path here answers a job with null and drops
 * a worker from the pool, both of which fail silently if they are wrong.
 */
export type WorkerFactory = () => Worker

const openRealWorker: WorkerFactory = () =>
  new Worker(new URL('./highlight.worker.ts', import.meta.url).href, { type: 'module' })

let openWorker: WorkerFactory = openRealWorker

/** Swap the worker this pool opens. Null restores the real one. */
export function setWorkerFactory(factory: WorkerFactory | null): void {
  openWorker = factory ?? openRealWorker
}

function limit(): number {
  if (capacity != null)
    return capacity

  const cores = typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
    ? navigator.hardwareConcurrency
    : 4

  capacity = poolSize(cores)
  return capacity
}

/**
 * Add one worker, if there is room and a reason.
 *
 * One at a time, on demand, rather than the whole pool on the first request -
 * and the difference is not small. Each worker parses every grammar as it
 * starts, so opening eight of them to tokenize one large file costs eight
 * grammar parses to save one file's tokenizing, which is a straight loss. A
 * pool that grows with the queue pays for the second thread only when there is
 * something for it to do.
 */
function grow(): PooledWorker | null {
  if (!available)
    return null

  workers ??= []
  if (workers.length >= limit())
    return null

  try {
    const worker = openWorker()
    const pooled: PooledWorker = { worker, job: null }

    // A pool must not keep a process alive. Without this a script that
    // highlights one file - the benchmark harness, a CLI command - finishes its
    // work, prints its answer, and then sits there forever because idle threads
    // are still registered with the event loop. It looks exactly like a hang in
    // the work, which is how this was found.
    const unref = (worker as { unref?: () => void }).unref
    if (typeof unref === 'function')
      unref.call(worker)

    worker.addEventListener('message', (event: MessageEvent) => finish(pooled, event.data as WorkerResponse))
    // A worker that dies takes its job with it. The job is answered with null
    // so the caller falls back to tokenizing in process, and the worker is
    // dropped from the pool rather than being handed more work it cannot do.
    worker.addEventListener('error', () => retire(pooled))

    workers.push(pooled)
    stats.workers = workers.length

    return pooled
  }
  catch {
    // No worker support, or the entry could not be loaded. Everything still
    // works; it just works on this thread.
    available = false
    return null
  }
}

function retire(pooled: PooledWorker): void {
  const job = pooled.job
  pooled.job = null

  if (job?.timer != null)
    clearTimeout(job.timer)

  if (job != null) {
    busy.delete(job.id)
    job.resolve(null)
  }

  if (workers != null) {
    workers = workers.filter(entry => entry !== pooled)
    stats.workers = workers.length
  }

  try {
    pooled.worker.terminate()
  }
  catch {
    // Already gone.
  }

  pump()
}

function finish(pooled: PooledWorker, response: WorkerResponse): void {
  const job = pooled.job
  pooled.job = null

  if (job?.timer != null)
    clearTimeout(job.timer)

  if (job == null || job.id !== response.id) {
    pump()
    return
  }

  busy.delete(job.id)

  if (job.cancelled) {
    job.resolve(null)
    pump()
    return
  }

  if (response.type === 'tokens')
    job.resolve(unpackLines(response.flat as FlatTokenLines))
  else
    job.resolve(null)

  pump()
}

/** Hand queued work to whichever workers are free, opening one if it helps. */
function pump(): void {
  while (pending.length > 0) {
    const free = (workers ?? []).find(pooled => pooled.job == null) ?? grow()
    if (free == null)
      return

    const job = pending.shift()
    if (job == null)
      return

    if (job.cancelled) {
      stats.cancelled += 1
      job.resolve(null)
      continue
    }

    free.job = job
    busy.set(job.id, free)
    stats.dispatched += 1

    job.timer = setTimeout(() => {
      // Answer without it. The worker is left alone rather than terminated: it
      // may simply be slow, and killing it would lose the grammars it has
      // parsed along with whatever else it was doing.
      if (free.job === job) {
        free.job = null
        busy.delete(job.id)
        job.cancelled = true
        job.resolve(null)
        pump()
      }
    }, WORKER_TIMEOUT_MS)

    free.worker.postMessage({
      id: job.id,
      type: 'tokenize',
      language: job.language,
      lines: [...job.lines],
    })
  }
}

/**
 * A handle on work in flight.
 *
 * `cancel` is what the on-demand row fetcher wants: a reader who scrolls past
 * forty files should not have the server finish tokenizing all of them. Best
 * effort, and honest about it - a job a worker has already started runs to
 * completion, because the tokenizer is a tight loop with nowhere to yield.
 */
export interface HighlightJob {
  tokens: Promise<FlatToken[][] | null>
  cancel: () => void
}

/**
 * Tokenize on a worker, or say it will not.
 *
 * Answers null - rather than throwing or waiting - for everything it declines:
 * too small to be worth a thread, no workers available, a worker that died, a
 * language with no grammar. Every one of those means "do it in process", and
 * collapsing them into one answer is what keeps the caller from having a branch
 * per failure mode.
 */
export function highlightOnWorker(lines: readonly string[], language: string): HighlightJob {
  let characters = 0
  for (const line of lines)
    characters += line.length + 1

  if (characters < WORKER_THRESHOLD_CHARS) {
    stats.inline += 1
    return { tokens: Promise.resolve(null), cancel: () => {} }
  }

  if (!available) {
    stats.inline += 1
    return { tokens: Promise.resolve(null), cancel: () => {} }
  }

  const id = nextId++
  let settle: (tokens: FlatToken[][] | null) => void = () => {}
  const tokens = new Promise<FlatToken[][] | null>((resolve) => { settle = resolve })

  const job: Job = { id, language, lines, resolve: settle, cancelled: false }
  pending.push(job)
  pump()

  return {
    tokens,
    cancel() {
      if (job.cancelled)
        return

      job.cancelled = true

      // Already with a worker: tell it, so it drops the reply rather than
      // posting a result nobody is waiting for.
      const holder = busy.get(id)
      if (holder != null)
        holder.worker.postMessage({ id, type: 'cancel' })
    },
  }
}

/**
 * Results, kept for a while.
 *
 * The hit that pays for this is not a second reader: it is the *same* reader
 * switching between unified and split. That refetches every file's rows, and
 * the content being tokenized is identical both times - the layouts differ in
 * how the rows are arranged, not in what the lines say.
 *
 * Keyed by the content rather than by the path, so it is correct across
 * branches, commits and forks without anything having to remember to invalidate
 * it. A hash rather than the text, because holding the text would mean the
 * cache is the memory the whole design exists to avoid.
 */
const CACHE_LIMIT = 256
const cache = new Map<string, FlatToken[][]>()

/** A cheap, non-cryptographic digest. Collisions cost a wrong colour, not a wrong line. */
export function contentKey(lines: readonly string[], language: string): string {
  let hash = 2166136261
  let length = 0

  for (const line of lines) {
    length += line.length
    for (let index = 0; index < line.length; index++) {
      hash ^= line.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    hash ^= 10
    hash = Math.imul(hash, 16777619)
  }

  // The length and the line count go in the key rather than the hash, so two
  // different files have to agree on all three to collide.
  return `${language}:${lines.length}:${length}:${(hash >>> 0).toString(36)}`
}

export function cachedTokens(key: string): FlatToken[][] | undefined {
  const hit = cache.get(key)
  if (hit === undefined)
    return undefined

  // Re-inserted so the most recently used is last, which is what makes the
  // eviction below least-recently-used rather than arbitrary.
  cache.delete(key)
  cache.set(key, hit)
  stats.cached += 1

  return hit
}

export function cacheTokens(key: string, tokens: FlatToken[][]): void {
  cache.set(key, tokens)

  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined)
      break
    cache.delete(oldest)
  }
}

/** Drop everything. For tests, and for an operator who wants the memory back. */
export function resetHighlightPool(): void {
  cache.clear()

  // Answer everything in flight *before* terminating the workers that would
  // have answered it. A reset happens while requests are in progress - a theme
  // change is the real case - and each one of those is a caller holding a
  // promise. Clearing the queue without resolving it left every one of them
  // waiting forever, which is not a slow page but a page that never finishes,
  // and null is a state all of them already handle as "tokenize it here".
  for (const pooled of workers ?? []) {
    const job = pooled.job
    pooled.job = null

    if (job != null) {
      if (job.timer != null)
        clearTimeout(job.timer)
      job.resolve(null)
    }

    try {
      pooled.worker.terminate()
    }
    catch {
      // Already gone.
    }
  }

  for (const job of pending) {
    if (job.timer != null)
      clearTimeout(job.timer)
    job.resolve(null)
  }

  workers = null
  capacity = null
  available = true
  pending.length = 0
  busy.clear()

  // The real factory comes back, so a test that swapped it cannot leak a fake
  // worker into whatever runs next. A test wanting a fake sets it *after* the
  // reset, which is the order that cannot go wrong by forgetting something.
  openWorker = openRealWorker

  stats.workers = 0
  stats.dispatched = 0
  stats.cached = 0
  stats.inline = 0
  stats.cancelled = 0
}
