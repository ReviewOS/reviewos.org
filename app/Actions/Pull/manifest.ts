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
import { isGenerated, parseDiffFile } from './diff'
import { countRows } from './metrics'
import { createPatchSplitter, releaseDetachBuffer } from './patch'

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

export type ManifestRecord = ManifestFile | ManifestEnd | ManifestError

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
 * Turn a stream of patch text into a stream of manifest records.
 *
 * Always ends with exactly one terminal record, an `end` or an `error`, so a
 * reader can tell a diff with no files from a connection that was cut. That
 * distinction is the difference between "nothing changed" and "something
 * broke", and a viewer that cannot tell them apart shows the wrong one.
 */
export async function* streamManifest(source: ManifestSource): AsyncGenerator<ManifestRecord> {
  const splitter = createPatchSplitter()
  let index = 0
  let additions = 0
  let deletions = 0

  const emit = function* (fileText: string): Generator<ManifestFile> {
    // Not detached: the record is serialized and dropped on the next line, so
    // it never outlives the text it was cut from and copying would be pure
    // cost. The server-side row cache is where detaching earns its keep.
    const file = parseDiffFile(fileText)
    if (!file)
      return

    additions += file.additions
    deletions += file.deletions
    yield manifestFile(file, index++)
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

/** git's complaint, trimmed to something worth showing a reader. */
function describeGitFailure(result: { code: number, stderr: string }): string {
  const message = result.stderr.trim().split('\n').find(line => line.trim().length > 0)
  return message ?? `git exited with code ${result.code}.`
}
