/**
 * The manifest: what the browser is told about a diff before it is shown one.
 *
 * This is the piece that decides whether a large review is possible. The
 * browser never receives the patch. It receives one small record per file -
 * path, status, counts, and how many rows the file will render as - which is
 * roughly two hundred bytes each. Forty thousand files is a few megabytes, so
 * the list can be laid out and scrolled the moment the manifest lands, with
 * every file's position already known and nothing mounted.
 *
 * The records are emitted as they are parsed, so the first file is on the wire
 * while git is still writing the last. Nothing here ever holds the whole patch:
 * the splitter keeps one file, this keeps one record, and both are released.
 *
 * The contrast worth keeping in mind is a viewer with no server, which has to
 * ship the patch to the browser and parse it there. That is why those crash on
 * a phone. We have a server; this is it doing its job.
 */

import type { HunkKind } from './classify'
import type { DiffFile, FileStatus } from './diff'
import type { DiffTokenMap } from './rows'
import type { RowCounts } from './metrics'
import type { StoredThread } from './loadThreads'
import { classifyFile } from './classify'
import { isGenerated, parseDiffFile } from './diff'
import { countRows } from './metrics'
import { createPatchSplitter, releaseDetachBuffer } from './patch'
import { highlightDiffFile, renderDiffFile } from './rows'
import { anchorThreadsToFile } from './loadThreads'
import { threadSlotFor } from './threads'

/**
 * Changed lines past which a file arrives collapsed.
 *
 * Not hidden: the header, the path and the counts are all still there, and one
 * click opens it. The point is that a reviewer opening a pull request should
 * land on the changes somebody wants them to read, not on the eight thousand
 * line regeneration that happens to sort first alphabetically.
 */
export const COLLAPSE_ABOVE_CHANGED_LINES = 500

/**
 * How many files may be tokenized at once, ahead of what is being emitted.
 *
 * Enough to keep a pool of workers busy, and small enough that a truncated
 * diff throws away only a file or two of work. It also bounds how much of the
 * patch is retained: a file in flight holds the chunk it was cut from.
 */
export const LOOK_AHEAD = 4

/**
 * How many files may be emitted before the event loop gets a turn.
 *
 * Counted rather than timed, and that is the whole trick. This is a pull-based
 * generator, so it is suspended between records - which means elapsed *wall*
 * time includes the consumer's time and the time spent suspended, and a budget
 * measured that way finds every file over budget. Yielding per file took a 1.4
 * second compare to 33 seconds. A count has no such confusion.
 *
 * Five hundred and twelve is measured, not chosen. Handing control back is far
 * from free here, and the curve over a 5,722 file compare is steep enough that
 * guessing would have been hopeless:
 *
 *   every 32 files    17.3s total, 293ms worst hold
 *   every 128 files    5.1s total, 409ms
 *   every 512 files    0.8s total, 115ms
 *   every 2048 files   0.7s total, 274ms
 *   never              0.5s total, 499ms
 *
 * So this buys a bounded hold for about 50% more wall time on the largest
 * compare in the corpus, and both ends of the curve are worse than the middle.
 */
const FILES_PER_YIELD = 512

/**
 * Hand the event loop back, properly.
 *
 * Worth stating why a yield is needed at all, since this generator is already
 * full of `await`: because awaiting a promise that is already resolved is not a
 * yield. It queues a *microtask*, and the microtask queue runs to exhaustion
 * before a timer or a socket gets a turn - so a consumer that does nothing slow
 * keeps this generator running, file after file, in one uninterrupted cascade.
 * Every `await` in the chain looked like a yield and none of them was, which is
 * why the hold survived several rounds of adding more of them.
 *
 * `setImmediate` rather than `setTimeout(0)`, too. A timer has a floor of about
 * a millisecond, and paying that per yield is most of how the first attempt at
 * this turned a 1.4 second compare into a 33 second one.
 */
function yieldToLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

export interface ManifestFile {
  t: 'file'
  /** Position in the diff. The client renders in this order and never sorts. */
  i: number
  path: string
  /** Set for a rename or a copy. */
  from: string | null
  status: FileStatus
  binary: boolean
  additions: number
  deletions: number
  hunks: number
  /**
   * Rows in each layout.
   *
   * Both, because the reader can switch layout at any time and asking the
   * server again for the other number would be a round trip to learn something
   * already computed.
   */
  rows: RowCounts
  /** Collapsed on arrival. See `COLLAPSE_ABOVE_CHANGED_LINES`. */
  collapsed: boolean
  /**
   * Why nothing in this file needs reading line by line, when that is true.
   *
   * Sent so the file list can say it rather than merely fold the file. A
   * reviewer told "formatting only" can open it and check; a reviewer shown a
   * folded file with no reason has been asked to trust something nobody stated.
   */
  mechanical?: HunkKind
}

export interface ManifestRows {
  t: 'rows'
  /** The file these rows belong to, by its position in the diff. */
  i: number
  layout: 'unified' | 'split'
  html: string
}

/**
 * Rows stopped here; everything from `from` onwards is fetched on demand.
 *
 * Sent rather than inferred, because a client that simply never received rows
 * for a file cannot tell "still coming" from "you will have to ask".
 */
export interface ManifestRowsTruncated {
  t: 'rows-truncated'
  from: number
}

export interface ManifestEnd {
  t: 'end'
  files: number
  additions: number
  deletions: number
}

export interface ManifestError {
  t: 'error'
  message: string
}

/**
 * git succeeded but said something the reader should know.
 *
 * The case this exists for: past `diff.renameLimit` git silently stops looking
 * for renames, writes a warning to stderr, and exits zero. The diff that comes
 * back is correct as far as it goes, but a moved file renders as a deletion and
 * an addition with nothing saying why, and a reviewer reads it as two thousand
 * lines of new code. Discarding a warning because the exit code was clean is
 * how that happens.
 */
export interface ManifestNotice {
  t: 'notice'
  message: string
}

export type ManifestRecord =
  | ManifestFile
  | ManifestRows
  | ManifestRowsTruncated
  | ManifestNotice
  | ManifestEnd
  | ManifestError

/**
 * Whether a file arrives folded up.
 *
 * The one place this is decided. It used to be decided twice - once here for
 * the streamed list and once in `resources/functions/review.ts` for the
 * server-rendered page - and two copies of a policy is how the same pull
 * request comes to look different depending on which screen you opened it from.
 */
export function startsCollapsed(file: {
  path: string
  status: FileStatus
  additions: number
  deletions: number
}): boolean {
  // A deletion is rarely something to read line by line. What the file used to
  // contain is not the change; the fact that it is gone is, and that is on the
  // header either way.
  if (file.status === 'deleted')
    return true

  if (isGenerated(file.path))
    return true

  return file.additions + file.deletions > COLLAPSE_ABOVE_CHANGED_LINES
}

/** One file's record. Pure, so the collapse policy is testable on its own. */
export function manifestFile(file: DiffFile, index: number): ManifestFile {
  // A file with a single mechanical reason folds on arrival and says why. A
  // file that is *partly* mechanical does not: the honest summary of it is the
  // diff, and folding it would be a claim nobody can check without opening it.
  const classification = file.hunks.length > 0 ? classifyFile(file) : null
  const mechanical = classification?.reason ?? undefined

  return {
    t: 'file',
    i: index,
    path: file.path,
    from: file.previousPath,
    status: file.status,
    binary: file.binary,
    additions: file.additions,
    deletions: file.deletions,
    hunks: file.hunks.length,
    rows: countRows(file),
    collapsed: startsCollapsed(file) || mechanical !== undefined,
    ...(mechanical ? { mechanical } : {}),
  }
}

export interface ManifestSource {
  chunks: AsyncIterable<string>
  done: Promise<{ ok: boolean, code: number, stderr: string }>
}

/**
 * How much rendered markup rides along with the manifest.
 *
 * Under it, a diff is *inline*: the rows arrive with the file list and the
 * reader can scroll the whole thing without another request. Over it, rows stop
 * and the rest is fetched as the reader reaches it.
 *
 * Eight megabytes covers very nearly every pull request anyone actually opens,
 * and is small enough that a phone can hold it. It is a starting number rather
 * than a measured one, and the benchmark harness in the roadmap is what will
 * settle it.
 */
export const DEFAULT_INLINE_ROWS_BUDGET_BYTES = 8 * 1024 * 1024

/**
 * The budget in force, which an operator can move.
 *
 * Configurable for two reasons. A large instance may want a bigger one on a
 * fast link, or a smaller one for phones. And the benchmark harness needs to
 * pin the mode: measuring the on-demand path is impossible if every test diff
 * happens to fit inline.
 *
 * Read on each call rather than captured at import, so a test can move it
 * without reloading the module.
 */
export function inlineRowsBudgetBytes(): number {
  const configured = Number(process.env.DIFF_INLINE_ROWS_BUDGET)
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_INLINE_ROWS_BUDGET_BYTES
}

export interface ManifestOptions {
  /**
   * Render rows alongside the file records.
   *
   * Off by default, so a caller that only wants the file list (a tree, a
   * summary, a count) does not pay for highlighting it will throw away.
   */
  rows?: {
    layout: 'unified' | 'split'
    budgetBytes?: number
    /**
     * Send nothing for a file that arrives folded up.
     *
     * On for the manifest stream, where a collapsed file costs a header and
     * the rows are fetched if the reader opens it. Off - and it must be off -
     * when the caller has named the files it wants, because that request *is*
     * the reader opening it, and answering it with nothing leaves a collapsed
     * file that can never be read.
     */
    skipCollapsed?: boolean
    /**
     * Render only this window of rows, for a file too large to send whole.
     *
     * Only meaningful when the caller has named one file: a window is a range
     * within *a* file, and applying one range to several would be asking for
     * rows 1,000 to 1,200 of each of them, which is not a thing anybody wants.
     */
    range?: { from: number, to: number }
    /**
     * Review threads to place under the lines they were written about.
     *
     * As stored: each is anchored against its own file as that file goes past,
     * which is the only form that works while streaming, since the whole diff
     * is never held. This module does not know how to find them, and the rows
     * renderer does not know what they are.
     */
    threads?: readonly StoredThread[]
    /**
     * Render every line as one plain token, for the benchmark harness.
     *
     * The stubbed half of its two modes. Layout and paint are what a CSS change
     * is measured on, and a token span per word is a large and variable share
     * of both - so leaving highlighting on while measuring one means measuring
     * the tokenizer's opinion of the fixture along with the change. Off by
     * default, and never a reader-facing setting: an unhighlighted diff is a
     * worse diff, it is only a cleaner measurement.
     */
    highlight?: boolean
  }
}

/**
 * Turn a stream of patch text into a stream of manifest records.
 *
 * Always ends with exactly one terminal record, an `end` or an `error`, so a
 * reader can tell a diff with no files from a connection that was cut. That
 * distinction is the difference between "nothing changed" and "something
 * broke", and a viewer that cannot tell them apart shows the wrong one.
 */
export async function* streamManifest(
  source: ManifestSource,
  options: ManifestOptions = {},
): AsyncGenerator<ManifestRecord> {
  const splitter = createPatchSplitter()
  const rowOptions = options.rows
  const budget = rowOptions?.budgetBytes ?? inlineRowsBudgetBytes()

  let index = 0
  let additions = 0
  let deletions = 0
  let spent = 0
  let truncatedAt: number | null = null

  /**
   * Files whose highlighting has been started and whose rows have not been
   * emitted yet.
   *
   * This is the look-ahead, and it is the only reason the highlight pool has
   * anything to be a pool *of*. Awaiting each file before beginning the next
   * means one job is ever in flight, so a pool of eight workers runs one - and
   * the wall clock is the sum of every file's tokenizing however many cores the
   * machine has.
   *
   * What is *not* reordered is the emission. Records come out in file order,
   * which is what keeps the inline row budget honest: it is spent in order, so
   * `rows-truncated` names the file it actually stopped at rather than
   * whichever file happened to finish first. The cost of that is a file or two
   * highlighted past the truncation point and thrown away, which is bounded by
   * the look-ahead and is a much better trade than a fuzzy boundary.
   */
  const inFlight: Array<{ at: number, file: DiffFile, tokens: Promise<DiffTokenMap> }> = []

  /** Turn one file whose tokens are ready into its rows record. */
  const rowsFor = async function* (entry: typeof inFlight[number]): AsyncGenerator<ManifestRecord> {
    const tokens = await entry.tokens

    // Reached when an earlier file spent the last of the budget while this one
    // was being tokenized. The work is thrown away, which is the price of
    // looking ahead, and the boundary stays exactly where it belongs.
    if (truncatedAt !== null || !rowOptions)
      return

    const html = renderDiffFile(entry.file, {
      layout: rowOptions.layout,
      expandable: true,
      commentable: true,
      range: rowOptions.range,
      // Always the open form. Whether a file is *shown* folded is the client's
      // decision and it can change at any moment, so markup rendered folded
      // would have to be thrown away the instant the reader clicked. A file
      // that arrives folded is handled by not sending rows for it at all,
      // above; anything that reaches here is rows somebody wants.
      tokens,
      threadsAt: rowOptions.threads
        ? threadSlotFor(anchorThreadsToFile(rowOptions.threads, entry.file), entry.file.path)
        : undefined,
    })

    spent += html.length
    if (spent > budget) {
      truncatedAt = entry.at
      yield { t: 'rows-truncated', from: entry.at }
      return
    }

    yield { t: 'rows', i: entry.at, layout: rowOptions.layout, html }
  }

  /** Emit the rows of everything past the look-ahead, oldest first. */
  const drain = async function* (all: boolean): AsyncGenerator<ManifestRecord> {
    while (inFlight.length > (all ? 0 : LOOK_AHEAD)) {
      const entry = inFlight.shift()
      if (entry == null)
        return

      yield* rowsFor(entry)
    }
  }

  const emit = async function* (fileText: string): AsyncGenerator<ManifestRecord> {
    // Not detached: the record is serialized and dropped on the next line, so
    // it never outlives the text it was cut from and copying would be pure
    // cost. The server-side row cache is where detaching earns its keep.
    const file = parseDiffFile(fileText)
    if (!file)
      return

    const at = index++
    additions += file.additions
    deletions += file.deletions

    const record = manifestFile(file, at)
    yield record

    if (!rowOptions || truncatedAt !== null)
      return

    // A file that arrives folded up gets no rows and is not highlighted. It is
    // folded because somebody decided it is not what this review is about - a
    // lock file, a regenerated snapshot - and highlighting eight thousand lines
    // of it, sending them, and parsing them into a hidden element is the whole
    // cost of showing it with none of the benefit. The client builds the header
    // from the record, and the rows are fetched if the reader opens it.
    if (record.collapsed && rowOptions.skipCollapsed)
      return

    // Started, not awaited. This is the whole change: the next file's record is
    // parsed and sent while this one is still being tokenized, and several
    // files are tokenized at once.
    inFlight.push({ at, file, tokens: highlightDiffFile(file, { highlight: rowOptions.highlight }) })

    yield* drain(false)
  }

  let sinceYield = 0

  try {
    for await (const chunk of source.chunks) {
      splitter.push(chunk)

      for (;;) {
        const fileText = splitter.take()
        if (fileText === undefined)
          break

        yield* emit(fileText)

        if (++sinceYield >= FILES_PER_YIELD) {
          sinceYield = 0
          await yieldToLoop()
        }
      }
    }

    for (const fileText of splitter.finish().files)
      yield* emit(fileText)

    // Everything still in the look-ahead, in file order.
    yield* drain(true)
  }
  finally {
    releaseDetachBuffer()
  }

  const result = await source.done
  if (!result.ok) {
    // Reached after files have already been emitted when git dies partway. The
    // reader has a partial diff and is told so, which beats a silent short
    // read that looks like a complete small change.
    yield { t: 'error', message: describeGitFailure(result) }
    return
  }

  for (const notice of gitNotices(result.stderr))
    yield { t: 'notice', message: notice }

  yield { t: 'end', files: index, additions, deletions }
}

/**
 * Serialize a manifest as newline-delimited JSON.
 *
 * One record per line, so the client parses with `split('\n')` and never waits
 * for a closing bracket. A single JSON array would have to be complete before
 * it could be read, which would give back everything the streaming bought.
 */
export async function* manifestToNdjson(records: AsyncIterable<ManifestRecord>): AsyncGenerator<string> {
  for await (const record of records)
    yield `${JSON.stringify(record)}\n`
}

/**
 * Warnings git wrote while succeeding.
 *
 * Only the ones that change what the reader is looking at. git's suggestion to
 * raise `diff.renameLimit` is advice for whoever runs the server and not
 * something to put in front of a reviewer, so the two lines are collapsed into
 * one statement of what it means for the diff on screen.
 */
function gitNotices(stderr: string): string[] {
  const notices: string[] = []

  if (/rename detection was skipped/i.test(stderr)) {
    notices.push(
      'This diff is large enough that git stopped looking for renames, so some moved files '
      + 'are shown as a deletion and an addition.',
    )
  }

  return notices
}

/** git's complaint, trimmed to something worth showing a reader. */
function describeGitFailure(result: { code: number, stderr: string }): string {
  const message = result.stderr.trim().split('\n').find(line => line.trim().length > 0)
  return message ?? `git exited with code ${result.code}.`
}
