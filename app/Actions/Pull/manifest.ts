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

import type { DiffFile, FileStatus } from './diff'
import type { RowCounts } from './metrics'
import type { StoredThread } from './loadThreads'
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

/** One file's record. Pure, so the collapse policy is testable on its own. */
export function manifestFile(file: DiffFile, index: number): ManifestFile {
  const changed = file.additions + file.deletions

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
    collapsed: isGenerated(file.path) || changed > COLLAPSE_ABOVE_CHANGED_LINES,
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
     * Review threads to place under the lines they were written about.
     *
     * As stored: each is anchored against its own file as that file goes past,
     * which is the only form that works while streaming, since the whole diff
     * is never held. This module does not know how to find them, and the rows
     * renderer does not know what they are.
     */
    threads?: readonly StoredThread[]
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
    yield manifestFile(file, at)

    if (!rowOptions || truncatedAt !== null)
      return

    // Highlighting is the expensive half, so it stops at the budget rather than
    // at the end of the diff. Past that point the file records keep flowing at
    // full speed, which is what keeps the scrollbar correct on a compare nobody
    // could render inline.
    const tokens = await highlightDiffFile(file)
    const html = renderDiffFile(file, {
      layout: rowOptions.layout,
      tokens,
      threadsAt: rowOptions.threads
        ? threadSlotFor(anchorThreadsToFile(rowOptions.threads, file), file.path)
        : undefined,
    })

    spent += html.length
    if (spent > budget) {
      truncatedAt = at
      yield { t: 'rows-truncated', from: at }
      return
    }

    yield { t: 'rows', i: at, layout: rowOptions.layout, html }
  }

  try {
    for await (const chunk of source.chunks) {
      splitter.push(chunk)

      for (;;) {
        const fileText = splitter.take()
        if (fileText === undefined)
          break
        yield* emit(fileText)
      }
    }

    for (const fileText of splitter.finish().files)
      yield* emit(fileText)
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
