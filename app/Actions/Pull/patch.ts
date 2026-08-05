/**
 * Cutting a patch into files as it arrives, and letting go of the text.
 *
 * Two problems, both of which only appear at size, and both of which are
 * invisible in a test written against a twelve line diff.
 *
 * The first is latency. `git diff` on a large change takes seconds to finish
 * writing, and there is no reason a reader should watch a spinner for all of
 * them: the first file is complete long before the last one starts. So the
 * splitter takes chunks off a stream and hands out whole files the moment the
 * *following* file's header proves the previous one ended.
 *
 * The second is memory. `String.prototype.slice` in V8 does not copy: it
 * returns a rope pointing into the parent, so one retained line keeps the
 * entire patch alive. Parse a 600MB diff, keep a million line strings, and the
 * 600MB never goes. `detachString` forces a fresh backing store for the strings
 * we intend to keep.
 *
 * Pure over strings, so both are testable without a repository.
 */

/** The header that begins every file in `git diff` output. */
const FILE_BOUNDARY = 'diff --git '
const FILE_BOUNDARY_AT_LINE_START = `\n${FILE_BOUNDARY}`

/**
 * How much of the tail must stay unscanned between chunks.
 *
 * A boundary marker can be split across two reads, so after a fruitless scan we
 * rewind by one less than the marker's length. Rewinding by the full length
 * would re-examine a character we already know is not the start of a match, and
 * rewinding by less can miss a marker that straddles the join.
 */
const BOUNDARY_SCAN_OVERLAP = FILE_BOUNDARY_AT_LINE_START.length - 1

const NON_WHITESPACE = /\S/

/**
 * The index of the next file header at or after `from`, or null.
 *
 * A header only counts at the start of a line, which is why the search is for
 * the newline-prefixed form. The one exception is the very start of the patch,
 * where there is no preceding newline.
 */
export function findFileBoundary(text: string, from: number): number | null {
  const start = Math.max(from, 0)

  if (start === 0 && text.startsWith(FILE_BOUNDARY))
    return 0

  const index = text.indexOf(FILE_BOUNDARY_AT_LINE_START, start)
  return index === -1 ? null : index + 1
}

export interface PatchSplitter {
  /** Add a chunk of patch text. */
  push: (chunk: string) => void
  /**
   * The next complete file, or undefined when the current one is still open.
   *
   * Call until it returns undefined; one chunk can complete several files.
   */
  take: () => string | undefined
  /**
   * Close the stream and give back everything still buffered.
   *
   * `files` holds any that completed on the last chunk plus the final one,
   * which nothing follows to prove it ended and so can only be emitted here.
   * `remainder` is set instead when no header was ever seen, which means the
   * input was not `git diff` output and the caller decides what it was.
   */
  finish: () => { files: string[], remainder?: string }
}

/**
 * A splitter over a stream of patch text.
 *
 * Holds exactly one file at a time. The buffer is trimmed on every emit, so
 * peak memory is the largest single file rather than the whole patch.
 */
export function createPatchSplitter(): PatchSplitter {
  let buffer = ''
  // Where the currently-open file starts in `buffer`. Always 0 once a file is
  // open, since the buffer is trimmed to the boundary as each file is emitted,
  // but it is null before the first header arrives.
  let openFileStart: number | null = null
  let scanFrom = 0
  let sawBoundary = false

  /** Rewind far enough that a marker straddling the last join is still found. */
  const rewind = (minimum: number): number =>
    Math.max(minimum, buffer.length - BOUNDARY_SCAN_OVERLAP)

  const take = (): string | undefined => {
    if (openFileStart == null) {
      openFileStart = findFileBoundary(buffer, scanFrom)
      if (openFileStart == null) {
        // Everything before the first header is the patch preamble (a commit
        // message, `git format-patch` mail headers) and is not a file.
        scanFrom = rewind(0)
        return undefined
      }

      sawBoundary = true
      scanFrom = openFileStart + 1
    }

    const next = findFileBoundary(buffer, scanFrom)
    if (next == null) {
      scanFrom = rewind(openFileStart + 1)
      return undefined
    }

    const fileText = buffer.slice(openFileStart, next)
    buffer = buffer.slice(next)
    openFileStart = 0
    scanFrom = 1

    return NON_WHITESPACE.test(fileText) ? fileText : take()
  }

  return {
    push(chunk: string) {
      if (chunk.length > 0)
        buffer += chunk
    },

    take,

    finish() {
      const files: string[] = []

      // Drain anything the last chunk completed, so calling finish() without
      // draining first cannot lose files.
      for (;;) {
        const fileText = take()
        if (fileText === undefined)
          break
        files.push(fileText)
      }

      const rest = openFileStart == null ? buffer : buffer.slice(openFileStart)
      buffer = ''
      openFileStart = null
      scanFrom = 0

      if (!NON_WHITESPACE.test(rest))
        return { files }

      if (!sawBoundary)
        return { files, remainder: rest }

      files.push(rest)
      return { files }
    },
  }
}

/**
 * Cut a complete patch into per-file texts.
 *
 * The non-streaming form, for callers that already hold the whole thing. Built
 * on the same splitter so the two cannot disagree about where a file ends.
 */
export function splitPatchFiles(raw: string): string[] {
  const splitter = createPatchSplitter()
  splitter.push(raw)
  return splitter.finish().files
}

/**
 * Copy a string away from the buffer it was sliced out of.
 *
 * V8 represents `big.slice(a, b)` as a pointer into `big`, so retaining the
 * slice retains all of `big`. Every line we intend to keep past the parse goes
 * through here; the raw patch is then collectable.
 *
 * The encode/decode round trip is the cheapest way to force a fresh backing
 * store, and reusing one scratch buffer keeps it from allocating per line.
 */
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
const INITIAL_SCRATCH_BYTES = 4096
const LONE_SURROGATE = /[\uD800-\uDFFF]/
let scratch = new Uint8Array(INITIAL_SCRATCH_BYTES)

export function detachString(value: string): string {
  if (value.length === 0)
    return value

  // TextEncoder replaces an unpaired surrogate with U+FFFD, and a diff can
  // contain arbitrary bytes that decoded into one. JSON survives the round trip
  // with the code unit intact and still allocates a new string.
  if (LONE_SURROGATE.test(value))
    return JSON.parse(JSON.stringify(value)) as string

  // Without surrogates every UTF-16 code unit is at most 3 UTF-8 bytes.
  const needed = value.length * 3
  if (scratch.length < needed)
    scratch = new Uint8Array(needed)

  const { written } = encoder.encodeInto(value, scratch)
  return decoder.decode(scratch.subarray(0, written))
}

/**
 * Drop the scratch buffer back to its starting size.
 *
 * Call after a parse. One pathological line (a minified bundle on one line, say)
 * would otherwise pin its own peak allocation for the life of the process.
 */
export function releaseDetachBuffer(): void {
  if (scratch.length !== INITIAL_SCRATCH_BYTES)
    scratch = new Uint8Array(INITIAL_SCRATCH_BYTES)
}
