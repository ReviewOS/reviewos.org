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
 * The line that begins each commit in a mailbox-format patch.
 *
 * `git format-patch` writes one mail message per commit and `git am` reads them
 * back. Between two commits sits a signature, a blank line, a `From` line, mail
 * headers, a subject and a diffstat - and the diffstat's lines begin with a
 * space, which is exactly what a context line looks like.
 *
 * Without this, the last file of one commit ran on to the first file of the
 * next, and every intervening line that happened to start with a space became a
 * context line appended to it. The file rendered with a tail of somebody's
 * commit message in it, numbered as though it were code.
 */
const MAILBOX_BOUNDARY = 'From '
const MAILBOX_BOUNDARY_AT_LINE_START = `\n${MAILBOX_BOUNDARY}`

/** `From `, a full commit sha, and the space before the date. */
export const MAILBOX_HEADER = /^From [0-9a-f]{40} /

/** How much text `MAILBOX_HEADER` needs to match against. */
const MAILBOX_HEADER_LENGTH = MAILBOX_BOUNDARY.length + 40 + 1

/**
 * How much of the tail must stay unscanned between chunks.
 *
 * A boundary marker can be split across two reads, so after a fruitless scan we
 * rewind by one less than the marker's length. Rewinding by the full length
 * would re-examine a character we already know is not the start of a match, and
 * rewinding by less can miss a marker that straddles the join.
 *
 * The longer of the two markers decides it. The mailbox one is only recognised
 * once its whole sha has arrived, so rewinding by the length of the file header
 * alone would let a commit boundary sitting across a chunk join go unseen.
 */
const BOUNDARY_SCAN_OVERLAP = Math.max(FILE_BOUNDARY_AT_LINE_START.length, MAILBOX_HEADER_LENGTH + 1) - 1

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

/**
 * The index of the next mailbox commit header at or after `from`, or null.
 *
 * The sha is required, which is what keeps this from firing on a `From:` mail
 * header or on a line of prose. A line of diff *content* cannot match at all,
 * because content always carries its origin marker, so column zero of a content
 * line is a space, a plus or a minus.
 */
export function findMailboxBoundary(text: string, from: number, limit = text.length): number | null {
  if (from <= 0 && MAILBOX_HEADER.test(text))
    return 0

  let cursor = Math.max(from, 0)

  for (;;) {
    const at = text.indexOf(MAILBOX_BOUNDARY_AT_LINE_START, cursor)
    if (at === -1 || at >= limit)
      return null

    const line = at + 1
    if (MAILBOX_HEADER.test(text.slice(line, line + MAILBOX_HEADER_LENGTH)))
      return line

    // A `From ` that is not a commit header - somebody's prose, or a mail
    // header. Keep looking rather than giving up on the whole scan.
    cursor = line
  }
}

/**
 * The earlier of the two boundaries, or null when neither is ahead.
 *
 * The mailbox scan is bounded by where the file scan landed, and that bound is
 * the whole reason this is a function rather than two calls. Unbounded, a patch
 * with no mailbox headers in it - which is every patch this application
 * produces - scanned the entire remaining buffer once per file looking for a
 * marker that was never there. Splitting a five thousand file patch went
 * quadratic and doubled, measurably, on a hundred file one.
 */
function findBoundary(text: string, from: number): number | null {
  const file = findFileBoundary(text, from)

  return findMailboxBoundary(text, from, file ?? text.length) ?? file
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
      // The *file* header specifically. A commit header does not open a file,
      // and treating it as one would only make the parser reject the mail
      // headers under it.
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

    // Either boundary ends the open file: the next file, or the next commit.
    const next = findBoundary(buffer, scanFrom)
    if (next == null) {
      scanFrom = rewind(openFileStart + 1)
      return undefined
    }

    const fileText = buffer.slice(openFileStart, next)
    buffer = buffer.slice(next)
    // A commit header is not a file, so the next file has to be looked for
    // again from here rather than assumed to start at zero.
    openFileStart = buffer.startsWith(FILE_BOUNDARY) ? 0 : null
    scanFrom = openFileStart === 0 ? 1 : 0

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

      // Read before the state is cleared: whether a file was open is the thing
      // that decides what the remainder is.
      const wasOpen = openFileStart != null
      const rest = wasOpen ? buffer.slice(openFileStart!) : buffer
      buffer = ''
      openFileStart = null
      scanFrom = 0

      if (!NON_WHITESPACE.test(rest))
        return { files }

      if (!sawBoundary)
        return { files, remainder: rest }

      // A boundary was seen but nothing is open, so what is left began at a
      // commit header rather than at a file: the signature and mail headers
      // that close a mailbox patch. Handing it over as a file would only make
      // the parser reject it.
      if (!wasOpen)
        return { files }

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
