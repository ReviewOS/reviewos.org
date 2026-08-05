/**
 * Turning git's output into values.
 *
 * Every parser here is pure, so the shapes that break parsers can be tested
 * without a repository: a filename containing a tab, a commit message
 * containing whatever the author felt like, a rename recorded as two paths in
 * one record, a file with no trailing newline.
 *
 * The rule every format below follows is the one `parseTreeEntries` follows:
 * **ask git for NUL-delimited output and never split on whitespace where a
 * filename can appear.** A filename may legally contain a newline, a tab, and
 * every quoting character; NUL is the only byte it cannot contain. Anything
 * that splits on `\n` here is parsing a field git guarantees has no filename in
 * it, and says so.
 */

export interface TreeEntry {
  mode: string
  type: 'blob' | 'tree' | 'commit'
  sha: string
  /** Null for trees and submodules, which have no meaningful size. */
  size: number | null
  name: string
}

/**
 * Parse `git ls-tree -z --long` output.
 *
 * The `-z` matters and is why this is not a `split('\n')`. A filename may
 * legally contain a newline, and that is a classic way to make a parser report
 * one entry as two - which in a file browser means inventing a file that does
 * not exist. NUL cannot appear in a filename, so it is the only safe delimiter.
 *
 * Each record is `<mode> <type> <sha> <size>\t<name>`, and the name is taken
 * from the first tab onward rather than by splitting, since a name may contain
 * tabs too.
 */
export function parseTreeEntries(stdout: string): TreeEntry[] {
  const entries: TreeEntry[] = []

  for (const record of stdout.split('\0')) {
    if (!record) continue

    const tab = record.indexOf('\t')
    if (tab === -1) continue

    const meta = record.slice(0, tab).trim().split(/\s+/)
    if (meta.length < 4) continue

    const type = meta[1]
    if (type !== 'blob' && type !== 'tree' && type !== 'commit') continue

    entries.push({
      mode: meta[0]!,
      type,
      sha: meta[2]!,
      // git prints `-` for anything without a size.
      size: meta[3] === '-' ? null : Number(meta[3]),
      name: record.slice(tab + 1),
    })
  }

  return entries
}

/** One file's change within a commit or a comparison. */
export interface ChangedFile {
  path: string
  /** Where it came from, when git recorded a rename or a copy. */
  from: string | null
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed' | 'unmerged' | 'unknown'
  additions: number
  deletions: number
  /** True when git reported `-` rather than a count, which means binary. */
  binary: boolean
}

export interface CommitDetail {
  sha: string
  parents: string[]
  subject: string
  body: string
  authorName: string
  authorEmail: string
  authoredAt: string
  committerName: string
  committedAt: string
}

/** The format string `parseCommitDetail` expects, kept next to the parser. */
export const COMMIT_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%cI%x00%s%x00%b'

/**
 * Read one commit from `git log -1 --format=COMMIT_FORMAT`.
 *
 * The body comes last on purpose: it is the only field that can contain
 * anything at all, including NUL-looking sequences once something re-encodes
 * it, so putting it at the end means a surprise there cannot shift the fields
 * before it.
 */
export function parseCommitDetail(stdout: string): CommitDetail | null {
  const fields = stdout.split('\0')
  const sha = (fields[0] ?? '').trim()

  if (!/^[0-9a-f]{40}$/.test(sha))
    return null

  return {
    sha,
    parents: (fields[1] ?? '').trim().split(/\s+/).filter(Boolean),
    authorName: fields[2] ?? '',
    authorEmail: fields[3] ?? '',
    authoredAt: fields[4] ?? '',
    committerName: fields[5] ?? '',
    committedAt: fields[6] ?? '',
    subject: fields[7] ?? '',
    // Trailing newlines are git's, not the author's.
    body: (fields.slice(8).join('\0') ?? '').replace(/\n+$/, ''),
  }
}

/**
 * Read `git diff --numstat -z` (or `diff-tree --numstat -z`).
 *
 * The `-z` form is not merely the tab form with NULs. For an ordinary change a
 * record is `additions\tdeletions\tpath\0`; for a rename or a copy the path
 * field is *empty* and the two paths follow as their own NUL-terminated
 * records:
 *
 *     "12\t3\t\0" "old/name\0" "new/name\0"
 *
 * Reading that as one record per NUL - which is the obvious way - produces a
 * file called `old/name` with no counts and another called `new/name` with no
 * counts, and loses the change entirely. So the records are consumed with an
 * index rather than mapped over.
 *
 * Counts of `-` mean binary. They are reported as zero with `binary: true`
 * rather than as `NaN` leaking into a sum.
 */
export function parseNumstat(stdout: string): ChangedFile[] {
  const records = stdout.split('\0')
  const files: ChangedFile[] = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record)
      continue

    const firstTab = record.indexOf('\t')
    const secondTab = record.indexOf('\t', firstTab + 1)
    if (firstTab === -1 || secondTab === -1)
      continue

    const additions = record.slice(0, firstTab)
    const deletions = record.slice(firstTab + 1, secondTab)
    const inlinePath = record.slice(secondTab + 1)

    let from: string | null = null
    let path: string

    if (inlinePath) {
      path = inlinePath
    }
    else {
      // The rename form: the next two records are the old and new paths.
      from = records[index + 1] ?? ''
      path = records[index + 2] ?? ''
      index += 2
    }

    const binary = additions === '-' || deletions === '-'

    files.push({
      path,
      from: from || null,
      status: from ? 'renamed' : 'modified',
      additions: binary ? 0 : Number(additions) || 0,
      deletions: binary ? 0 : Number(deletions) || 0,
      binary,
    })
  }

  return files
}

const STATUS_LETTERS: Record<string, ChangedFile['status']> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type-changed',
  U: 'unmerged',
}

/**
 * Read `git diff --name-status -z`.
 *
 * Same two shapes as the numstat form: a letter and a path for most changes, a
 * letter with a similarity score followed by two path records for a rename or a
 * copy. Merged into the numstat result by path, because numstat knows how big a
 * change is and only this knows what kind it is.
 */
export function parseNameStatus(stdout: string): Array<{ path: string, from: string | null, status: ChangedFile['status'] }> {
  const records = stdout.split('\0')
  const changes: Array<{ path: string, from: string | null, status: ChangedFile['status'] }> = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record)
      continue

    const letter = record[0]!
    const status = STATUS_LETTERS[letter] ?? 'unknown'

    if (letter === 'R' || letter === 'C') {
      const from = records[index + 1] ?? ''
      const path = records[index + 2] ?? ''
      index += 2
      changes.push({ path, from: from || null, status })
      continue
    }

    // `A\0path\0`: the letter is its own record, the path is the next one.
    const inline = record.slice(1).replace(/^\t/, '')
    if (inline) {
      changes.push({ path: inline, from: null, status })
      continue
    }

    const path = records[index + 1] ?? ''
    index += 1
    if (path)
      changes.push({ path, from: null, status })
  }

  return changes
}

/**
 * Put the two together: sizes from numstat, kinds from name-status.
 *
 * numstat leads, because it is the one that reports every changed file with its
 * weight. A file that only name-status knows about (a pure rename with no
 * content change still appears in both, but a mode change may not) is appended
 * rather than dropped.
 */
export function mergeChangeStatus(
  files: readonly ChangedFile[],
  statuses: ReadonlyArray<{ path: string, from: string | null, status: ChangedFile['status'] }>,
): ChangedFile[] {
  const byPath = new Map(statuses.map(status => [status.path, status]))
  const merged = files.map((file) => {
    const status = byPath.get(file.path)
    return status ? { ...file, status: status.status, from: status.from ?? file.from } : file
  })

  const known = new Set(merged.map(file => file.path))

  for (const status of statuses) {
    if (known.has(status.path))
      continue

    merged.push({ ...status, additions: 0, deletions: 0, binary: false })
  }

  return merged
}

export interface BlameLine {
  /** 1-based, as an editor counts. */
  number: number
  sha: string
  authorName: string
  /** ISO 8601, from the author time and timezone git reports separately. */
  authoredAt: string
  summary: string
  text: string
  /** True on the first line of each run from the same commit, for the gutter. */
  startsGroup: boolean
}

/**
 * Read `git blame --porcelain`.
 *
 * The porcelain format states each commit's details once, the first time that
 * commit is seen, and then refers to it by sha alone - so a file where one
 * commit wrote nine hundred lines carries one header rather than nine hundred.
 * That means the parser has to *remember*: a line whose header is only a sha
 * takes its author from whatever was recorded earlier. Reading each line
 * independently gives every line after the first an empty author, which looks
 * like a blank column rather than like a bug.
 *
 * A record is a header line (`<sha> <orig-line> <final-line> [<count>]`),
 * optional `key value` lines, then the file's own line prefixed with a tab.
 */
export function parseBlame(stdout: string): BlameLine[] {
  const commits = new Map<string, { authorName: string, authoredAt: string, summary: string }>()
  const lines: BlameLine[] = []

  let current: { sha: string, number: number } | null = null
  let pending: { authorName?: string, authorTime?: string, authorTz?: string, summary?: string } = {}
  let previousSha = ''

  for (const raw of stdout.split('\n')) {
    if (raw.startsWith('\t')) {
      if (!current)
        continue

      const known = commits.get(current.sha)
      const details = {
        authorName: pending.authorName ?? known?.authorName ?? '',
        authoredAt: pending.authorTime
          ? isoFromEpoch(pending.authorTime, pending.authorTz)
          : known?.authoredAt ?? '',
        summary: pending.summary ?? known?.summary ?? '',
      }

      commits.set(current.sha, details)

      lines.push({
        number: current.number,
        sha: current.sha,
        ...details,
        text: raw.slice(1),
        startsGroup: current.sha !== previousSha,
      })

      previousSha = current.sha
      current = null
      pending = {}
      continue
    }

    const header = raw.match(/^([0-9a-f]{40}) \d+ (\d+)/)
    if (header) {
      current = { sha: header[1]!, number: Number(header[2]) }
      continue
    }

    if (raw.startsWith('author '))
      pending.authorName = raw.slice('author '.length)
    else if (raw.startsWith('author-time '))
      pending.authorTime = raw.slice('author-time '.length)
    else if (raw.startsWith('author-tz '))
      pending.authorTz = raw.slice('author-tz '.length)
    else if (raw.startsWith('summary '))
      pending.summary = raw.slice('summary '.length)
  }

  return lines
}

/**
 * git reports author time as a Unix timestamp and the author's offset
 * separately, so the two are put back together rather than the timestamp being
 * rendered in the server's timezone. `+0530` is a real offset that somebody
 * committed in, and losing it makes a commit look like it happened at a
 * different time of day than it did.
 */
function isoFromEpoch(seconds: string, timezone: string | undefined): string {
  const epoch = Number(seconds)
  if (!Number.isFinite(epoch))
    return ''

  const offset = /^[+-]\d{4}$/.test(timezone ?? '') ? timezone! : '+0000'
  const sign = offset[0] === '-' ? -1 : 1
  const minutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5)))

  const shifted = new Date((epoch + minutes * 60) * 1000)
  if (Number.isNaN(shifted.getTime()))
    return ''

  return `${shifted.toISOString().slice(0, 19)}${offset.slice(0, 3)}:${offset.slice(3, 5)}`
}

/** `git rev-list --left-right --count a...b`, which is `behind\tahead`. */
export function parseAheadBehind(stdout: string): { behind: number, ahead: number } {
  const [behind, ahead] = stdout.trim().split(/\s+/)

  return { behind: Number(behind) || 0, ahead: Number(ahead) || 0 }
}
