/**
 * Parsing unified diffs into something a review interface can render and anchor
 * comments to.
 *
 * git produces the diff; this turns its output into hunks with line numbers on
 * both sides, which is what a comment needs to point at. Pure over a string, so
 * the awkward shapes (a file with no trailing newline, a rename with no content
 * change, a binary file) can be tested without a repository.
 *
 * The unit is one file rather than the whole patch, because the streaming path
 * in `patch.ts` hands over one file at a time as it arrives. `parseDiff` is the
 * convenience wrapper for a caller that already holds a complete diff.
 */

import { detachString, splitPatchFiles } from './patch'

export type LineOrigin = 'context' | 'added' | 'removed'

export interface DiffLine {
  origin: LineOrigin
  content: string
  /** Line number on the left (the version being replaced), or null when added. */
  oldLine: number | null
  /** Line number on the right (the version proposed), or null when removed. */
  newLine: number | null
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** The text after the `@@`, which git uses for the enclosing function. */
  heading: string
  lines: DiffLine[]
}

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied'

export interface DiffFile {
  path: string
  /** Set for a rename or a copy. */
  previousPath: string | null
  status: FileStatus
  binary: boolean
  additions: number
  deletions: number
  hunks: DiffHunk[]
  /** A mode change with no content change is still worth showing. */
  oldMode: string | null
  newMode: string | null
}

export interface ParseDiffFileOptions {
  /**
   * Copy retained strings away from the text they were sliced out of.
   *
   * A slice in V8 points into its parent, so keeping one line of a 600MB patch
   * keeps all 600MB. Pass true when the parsed file outlives the text it came
   * from, which is the server-side cache; leave it off for a parse whose
   * output is serialized and dropped straight away, where it is pure overhead.
   */
  detach?: boolean
}

/**
 * Parse one file's worth of `git diff` output.
 *
 * This is the unit the streaming path works in: `createPatchSplitter` hands
 * over one of these as soon as the following file's header proves it complete,
 * so a reader sees the first file while git is still writing the last.
 *
 * Returns null when the text does not begin a file, which is how a caller
 * distinguishes patch preamble and malformed input from an empty diff.
 */
export function parseDiffFile(fileText: string, options: ParseDiffFileOptions = {}): DiffFile | null {
  const keep = options.detach === true ? detachString : identity
  const lines = fileText.split('\n')

  // `split` leaves an empty final element for the trailing newline every diff
  // ends with. Left in, it is counted as a blank context line and the file
  // gains a line it does not have.
  if (lines.length > 0 && lines[lines.length - 1] === '')
    lines.pop()

  const header = lines[0]
  if (header === undefined || !header.startsWith('diff --git '))
    return null

  const file: DiffFile = {
    path: keep(pathFromDiffHeader(header)),
    previousPath: null,
    status: 'modified',
    binary: false,
    additions: 0,
    deletions: 0,
    hunks: [],
    oldMode: null,
    newMode: null,
  }

  let hunk: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!

    // A second header inside one file's text means the splitter cut on a line
    // that only looked like a boundary. Stop rather than folding two files
    // into one.
    if (line.startsWith('diff --git '))
      break

    if (line.startsWith('new file mode ')) {
      file.status = 'added'
      file.newMode = line.slice('new file mode '.length).trim()
      continue
    }

    if (line.startsWith('deleted file mode ')) {
      file.status = 'deleted'
      file.oldMode = line.slice('deleted file mode '.length).trim()
      continue
    }

    if (line.startsWith('old mode ')) {
      file.oldMode = line.slice('old mode '.length).trim()
      continue
    }

    if (line.startsWith('new mode ')) {
      file.newMode = line.slice('new mode '.length).trim()
      continue
    }

    if (line.startsWith('rename from ')) {
      file.status = 'renamed'
      file.previousPath = keep(line.slice('rename from '.length))
      continue
    }

    if (line.startsWith('rename to ')) {
      file.status = 'renamed'
      file.path = keep(line.slice('rename to '.length))
      continue
    }

    if (line.startsWith('copy from ')) {
      file.status = 'copied'
      file.previousPath = keep(line.slice('copy from '.length))
      continue
    }

    if (line.startsWith('copy to ')) {
      file.status = 'copied'
      file.path = keep(line.slice('copy to '.length))
      continue
    }

    // "Binary files a/x and b/x differ", or the header of a binary patch.
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      file.binary = true
      continue
    }

    const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line)
    if (hunkHeader) {
      hunk = {
        oldStart: Number(hunkHeader[1]),
        oldLines: hunkHeader[2] === undefined ? 1 : Number(hunkHeader[2]),
        newStart: Number(hunkHeader[3]),
        newLines: hunkHeader[4] === undefined ? 1 : Number(hunkHeader[4]),
        heading: keep(hunkHeader[5]!.trim()),
        lines: [],
      }
      file.hunks.push(hunk)
      oldLine = hunk.oldStart
      newLine = hunk.newStart
      continue
    }

    if (!hunk)
      continue

    // git marks a missing final newline with this, and it belongs to the
    // preceding line rather than being a line of its own.
    if (line.startsWith('\\ No newline at end of file'))
      continue

    const marker = line[0]
    const content = keep(line.slice(1))

    if (marker === '+') {
      hunk.lines.push({ origin: 'added', content, oldLine: null, newLine })
      file.additions += 1
      newLine += 1
    }
    else if (marker === '-') {
      hunk.lines.push({ origin: 'removed', content, oldLine, newLine: null })
      file.deletions += 1
      oldLine += 1
    }
    else if (marker === ' ' || line === '') {
      hunk.lines.push({ origin: 'context', content, oldLine, newLine })
      oldLine += 1
      newLine += 1
    }
  }

  return file
}

/**
 * Parse a whole `git diff` output.
 *
 * The convenience form over `parseDiffFile`, for callers that already hold the
 * complete text. Anything that reads from a stream should use the splitter and
 * the per-file parser directly, so the first file is available while git is
 * still writing.
 */
export function parseDiff(raw: string, options: ParseDiffFileOptions = {}): DiffFile[] {
  const files: DiffFile[] = []

  for (const fileText of splitPatchFiles(raw)) {
    const file = parseDiffFile(fileText, options)
    if (file)
      files.push(file)
  }

  return files
}

/** Used in place of `detachString` when the parse output does not outlive its input. */
function identity(value: string): string {
  return value
}

/**
 * The path in a `diff --git a/x b/y` line.
 *
 * Reads the `b/` side, since that is where the file ends up. Paths containing
 * spaces make this ambiguous in general; git quotes those, and the quoted form
 * is handled below.
 */
function pathFromDiffHeader(line: string): string {
  const rest = line.slice('diff --git '.length)

  if (rest.startsWith('"')) {
    const closing = rest.indexOf('" "')
    if (closing !== -1)
      return unquote(rest.slice(closing + 2))
  }

  const bIndex = rest.lastIndexOf(' b/')
  if (bIndex !== -1)
    return rest.slice(bIndex + 3)

  return rest
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith('"'))
    return trimmed

  return trimmed.slice(1, -1).replace(/\\(.)/g, '$1')
}

/** Total additions and deletions across a set of files. */
export function diffTotals(files: DiffFile[]): { additions: number, deletions: number, files: number } {
  return {
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    files: files.length,
  }
}

/**
 * Files that are worth collapsing by default.
 *
 * A lockfile is a real change that nobody reads line by line, and leaving it
 * expanded pushes the changes that matter off the screen.
 */
export function isGenerated(path: string): boolean {
  const generated = [
    /(^|\/)(bun\.lock|bun\.lockb|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|Gemfile\.lock|go\.sum|poetry\.lock)$/,
    /(^|\/)(dist|build|vendor|node_modules)\//,
    /\.min\.(js|css)$/,
    /\.(map|snap)$/,
  ]

  return generated.some(pattern => pattern.test(path))
}

/**
 * Whether a hunk changes anything but whitespace.
 *
 * Used for the "hide whitespace" toggle, which is the difference between a
 * reviewable diff and a reformatted file.
 */
export function isWhitespaceOnly(hunk: DiffHunk): boolean {
  const added = hunk.lines.filter(line => line.origin === 'added').map(line => line.content.replace(/\s+/g, ''))
  const removed = hunk.lines.filter(line => line.origin === 'removed').map(line => line.content.replace(/\s+/g, ''))

  if (added.length === 0 && removed.length === 0)
    return false

  return added.join('\n') === removed.join('\n')
}
