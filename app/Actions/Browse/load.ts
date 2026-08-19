/**
 * Reading a repository's contents at a ref.
 *
 * Thin wrappers over git plumbing, kept apart from the actions so the browse
 * view and the JSON API read a repository the same way. Everything that shapes
 * the result for display lives in `resources/functions/browse`; this only
 * fetches.
 */

import type { BlameLine, ChangedFile, CommitDetail, TreeEntry } from './parse'
import { isSafeRevision, runGit } from '../Git/git'
import {
  COMMIT_FORMAT,
  parseTreeEntries,
  mergeChangeStatus,
  parseAheadBehind,
  parseBlame,
  parseCommitDetail,
  parseNameStatus,
  parseNumstat,
} from './parse'

/** How large a file may be before the browser declines to render it. */
export const MAX_BLOB_BYTES = 512 * 1024

/**
 * How much listing output one directory or comparison may produce.
 *
 * Two mebibytes of `ls-tree -z --long` is tens of thousands of entries in one
 * directory, and two mebibytes of `--numstat` is tens of thousands of changed
 * files - both far past what any page renders, and both cheap for a hostile or
 * degenerate repository to exceed. The flag matters as much as the budget: a
 * cut listing that does not say so renders as a directory with files missing,
 * which reads as data loss.
 */
export const LISTING_BYTE_LIMIT = 2 * 1024 * 1024

/**
 * Cut `-z` output back to its last complete record.
 *
 * A byte budget cuts mid-record, and a record cut mid-path is worse than one
 * dropped: it parses as a valid entry whose filename happens to be clipped,
 * which no parser can tell from a real file by that name.
 */
function completeRecords(result: { stdout: string, truncated?: boolean }): string {
  if (result.truncated !== true)
    return result.stdout

  return result.stdout.slice(0, result.stdout.lastIndexOf('\0') + 1)
}

export interface TreeListing {
  ok: boolean
  entries: TreeEntry[]
  /** Set when the ref or path does not resolve, for the view to show. */
  error: string | null
  /** True when the listing was cut at the byte budget, for the view to say. */
  truncated: boolean
}

/**
 * List a directory at a ref.
 *
 * A path that does not exist is not an exception: browsing to a stale link is
 * ordinary, and the view wants to say so rather than return a 500.
 */
export async function listTree(repositoryPath: string, ref: string, path = ''): Promise<TreeListing> {
  if (!isSafeRevision(ref))
    return { ok: false, entries: [], error: 'Invalid ref', truncated: false }

  // `-z` because a filename may contain a newline, `--long` for sizes.
  const target = path ? `${ref}:${path}` : ref
  const result = await runGit(repositoryPath, ['ls-tree', '-z', '--long', target], { maxBytes: LISTING_BYTE_LIMIT })

  if (!result.ok)
    return { ok: false, entries: [], error: 'No such path at that ref', truncated: false }

  return { ok: true, entries: parseTreeEntries(completeRecords(result)), error: null, truncated: result.truncated === true }
}

export interface BlobContent {
  ok: boolean
  text: string | null
  size: number
  /** True when the file is binary or too large, so the view offers a download instead. */
  tooLarge: boolean
  binary: boolean
  error: string | null
}

/**
 * Read a file at a ref.
 *
 * Refuses binary and oversized content rather than streaming megabytes of it
 * into a page: a browser that hangs on a vendored bundle is worse than one that
 * says the file is too large to show.
 */
export async function readBlob(repositoryPath: string, ref: string, path: string): Promise<BlobContent> {
  if (!isSafeRevision(ref))
    return { ok: false, text: null, size: 0, tooLarge: false, binary: false, error: 'Invalid ref' }

  const sizeResult = await runGit(repositoryPath, ['cat-file', '-s', `${ref}:${path}`])
  if (!sizeResult.ok)
    return { ok: false, text: null, size: 0, tooLarge: false, binary: false, error: 'No such file at that ref' }

  const size = Number(sizeResult.stdout.trim())
  if (size > MAX_BLOB_BYTES)
    return { ok: true, text: null, size, tooLarge: true, binary: false, error: null }

  const result = await runGit(repositoryPath, ['cat-file', 'blob', `${ref}:${path}`])
  if (!result.ok)
    return { ok: false, text: null, size, tooLarge: false, binary: false, error: 'Could not read file' }

  // A NUL byte is git's own heuristic for binary, and it is good enough: text
  // files do not contain one.
  if (result.stdout.includes('\0'))
    return { ok: true, text: null, size, tooLarge: false, binary: true, error: null }

  return { ok: true, text: result.stdout, size, tooLarge: false, binary: false, error: null }
}

export interface CommitSummary {
  sha: string
  subject: string
  authorName: string
  when: string
}

/**
 * The most recent commit touching a path, for the "last changed" line.
 *
 * Returns null rather than throwing on an empty repository, which is a state a
 * freshly created repository is legitimately in.
 */
export async function lastCommit(repositoryPath: string, ref: string, path = ''): Promise<CommitSummary | null> {
  if (!isSafeRevision(ref)) return null

  const args = ['log', '-1', '--format=%H%x00%s%x00%an%x00%aI', ref]
  if (path) args.push('--', path)

  const result = await runGit(repositoryPath, args)
  if (!result.ok || !result.stdout.trim()) return null

  const [sha, subject, authorName, when] = result.stdout.trim().split('\0')
  if (!sha) return null

  return { sha, subject: subject ?? '', authorName: authorName ?? '', when: when ?? '' }
}

/**
 * How many commits a ref has behind it.
 *
 * For the header, where the line read `main · 2 branches · commits · 0 B` - a
 * row of counts with a bare word in the middle of it, which reads as a number
 * that failed to render rather than as a link.
 *
 * `null` on an empty repository or a bad ref rather than 0, because those are
 * different facts and the header shows one and hides the other.
 */
export async function commitCount(repositoryPath: string, ref: string): Promise<number | null> {
  if (!isSafeRevision(ref)) return null

  const result = await runGit(repositoryPath, ['rev-list', '--count', ref])
  if (!result.ok) return null

  const count = Number(result.stdout.trim())

  return Number.isFinite(count) ? count : null
}

/** Branch names, for the ref picker. */
export async function branchNames(repositoryPath: string): Promise<string[]> {
  const result = await runGit(repositoryPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  if (!result.ok) return []
  return result.stdout.split('\n').map(l => l.trim()).filter(Boolean)
}

/** Tag names, newest first, for the ref picker. */
export async function tagNames(repositoryPath: string): Promise<string[]> {
  // Sorted by the date the tag points at rather than alphabetically: v10 after
  // v9 alphabetically is v1, v10, v2, which is useless on a release list.
  const result = await runGit(repositoryPath, [
    'for-each-ref',
    '--format=%(refname:short)',
    '--sort=-creatordate',
    'refs/tags',
  ])
  if (!result.ok) return []
  return result.stdout.split('\n').map(l => l.trim()).filter(Boolean)
}

/**
 * Commits touching a path, newest first.
 *
 * NUL-separated fields and a record separator, for the same reason the tree
 * listing is NUL-delimited: a commit subject may contain anything, including
 * the characters a naive format would split on.
 */
export async function commitHistory(
  repositoryPath: string,
  ref: string,
  path = '',
  limit = 50,
): Promise<CommitSummary[]> {
  if (!isSafeRevision(ref)) return []

  // %x00 between fields, %x1e (record separator) between commits.
  const args = ['log', `-${Math.max(1, Math.min(limit, 200))}`, '--format=%H%x00%s%x00%an%x00%aI%x1e', ref]
  if (path) args.push('--', path)

  const result = await runGit(repositoryPath, args)
  if (!result.ok) return []

  return result.stdout
    .split('\x1e')
    .map(record => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [sha, subject, authorName, when] = record.split('\0')
      return { sha: sha ?? '', subject: subject ?? '', authorName: authorName ?? '', when: when ?? '' }
    })
    .filter(c => c.sha.length > 0)
}

/**
 * One commit, with what it changed.
 *
 * A merge is diffed against its **first parent** rather than shown as a
 * combined diff. `git diff-tree` on a merge with no options prints nothing at
 * all, which reads as "this commit changed no files" - and a merge commit page
 * that says a merge changed nothing is worse than useless, because it is
 * confidently wrong. First parent answers the question people are actually
 * asking of a merge: what arrived on this branch.
 */
export interface CommitWithChanges extends CommitDetail {
  files: ChangedFile[]
  additions: number
  deletions: number
  /** True when this is a merge and the file list is against the first parent. */
  isMerge: boolean
}

export async function commitDetail(repositoryPath: string, revision: string): Promise<CommitWithChanges | null> {
  if (!isSafeRevision(revision))
    return null

  const shown = await runGit(repositoryPath, ['log', '-1', `--format=${COMMIT_FORMAT}`, revision])
  if (!shown.ok)
    return null

  const commit = parseCommitDetail(shown.stdout)
  if (!commit)
    return null

  const isMerge = commit.parents.length > 1

  // `--root` is what makes the very first commit in a repository show its files
  // rather than nothing: it has no parent to diff against, and without this git
  // treats that as an empty change set.
  const base = ['diff-tree', '-r', '--root', '-z', '-M', '--first-parent', commit.sha]

  const [numstat, nameStatus] = await Promise.all([
    runGit(repositoryPath, [...base, '--numstat']),
    runGit(repositoryPath, [...base, '--name-status']),
  ])

  const files = numstat.ok
    ? mergeChangeStatus(parseNumstat(stripDiffTreeHeader(numstat.stdout)), nameStatus.ok ? parseNameStatus(stripDiffTreeHeader(nameStatus.stdout)) : [])
    : []

  return {
    ...commit,
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    isMerge,
  }
}

/**
 * `diff-tree` prints the commit sha on its own before the records.
 *
 * With `-z` that sha is followed by a NUL like everything else, so it arrives
 * as a record that no format below recognises - it has no tab and no status
 * letter, so both parsers skip it. It is removed anyway rather than relied on
 * being skipped: a parser that silently ignores what it does not understand is
 * a parser that ignores a real record the day the format changes.
 */
function stripDiffTreeHeader(stdout: string): string {
  const firstNul = stdout.indexOf('\0')
  if (firstNul === -1)
    return stdout

  return /^[0-9a-f]{40}$/.test(stdout.slice(0, firstNul).trim())
    ? stdout.slice(firstNul + 1)
    : stdout
}

export interface Comparison {
  ok: boolean
  base: string
  head: string
  /** Where the two last agreed. Null when they share no history at all. */
  mergeBase: string | null
  ahead: number
  behind: number
  commits: CommitSummary[]
  files: ChangedFile[]
  additions: number
  deletions: number
  error: string | null
  /** True when the file list was cut at the byte budget, for the view to say. */
  truncated: boolean
}

/**
 * Compare two refs, the way a pull request does.
 *
 * Diffed from the **merge base**, not from the base tip. Diffing against the
 * tip shows every change made on the base since the branch left it, mixed in
 * with the author's own work, and that is the single most common way a review
 * interface misleads a reviewer - it shows them other people's commits and asks
 * them to approve.
 *
 * Two refs with no common ancestor are a real thing (an orphan branch, an
 * imported history) and are reported rather than treated as an error: the
 * comparison is then simply everything on the head side.
 */
export async function compareRefs(repositoryPath: string, base: string, head: string, limit = 100): Promise<Comparison> {
  const empty = {
    ok: false,
    base,
    head,
    mergeBase: null,
    ahead: 0,
    behind: 0,
    commits: [],
    files: [],
    additions: 0,
    deletions: 0,
    truncated: false,
  }

  if (!isSafeRevision(base) || !isSafeRevision(head))
    return { ...empty, error: 'Invalid ref' }

  const resolved = await Promise.all([
    runGit(repositoryPath, ['rev-parse', '--verify', `${base}^{commit}`]),
    runGit(repositoryPath, ['rev-parse', '--verify', `${head}^{commit}`]),
  ])

  if (!resolved[0].ok || !resolved[1].ok)
    return { ...empty, error: 'No such ref' }

  const mergeBaseResult = await runGit(repositoryPath, ['merge-base', base, head])
  const mergeBase = mergeBaseResult.ok ? mergeBaseResult.stdout.trim() || null : null

  // With no common ancestor there is nothing to diff *from*, so the comparison
  // is the head's whole history. `--root` on the diff covers the same case.
  const from = mergeBase ?? base

  const [counts, log, numstat, nameStatus] = await Promise.all([
    runGit(repositoryPath, ['rev-list', '--left-right', '--count', `${base}...${head}`]),
    runGit(repositoryPath, [
      'log',
      `-${Math.max(1, Math.min(limit, 500))}`,
      '--format=%H%x00%s%x00%an%x00%aI%x1e',
      mergeBase ? `${mergeBase}..${head}` : head,
    ]),
    runGit(repositoryPath, ['diff', '-z', '-M', '--numstat', `${from}..${head}`], { maxBytes: LISTING_BYTE_LIMIT }),
    runGit(repositoryPath, ['diff', '-z', '-M', '--name-status', `${from}..${head}`], { maxBytes: LISTING_BYTE_LIMIT }),
  ])

  const files = numstat.ok
    ? mergeChangeStatus(parseNumstat(completeRecords(numstat)), nameStatus.ok ? parseNameStatus(completeRecords(nameStatus)) : [])
    : []

  const { ahead, behind } = counts.ok ? parseAheadBehind(counts.stdout) : { ahead: 0, behind: 0 }

  return {
    ok: true,
    base,
    head,
    mergeBase,
    ahead,
    behind,
    commits: log.ok ? parseCommitRecords(log.stdout) : [],
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    error: mergeBase ? null : 'These refs share no history',
    truncated: numstat.truncated === true || nameStatus.truncated === true,
  }
}

/**
 * The unified diff between two refs, as text, in either compare mode.
 *
 * Merge-base mode is the three-dot form - what the head is proposing, the
 * diff a pull request renders. Direct is tip to tip, and the page saying so
 * is the caller's job: the text alone looks identical, which is exactly the
 * problem with it.
 */
export async function compareDiffText(
  repositoryPath: string,
  base: string,
  head: string,
  mode: 'merge-base' | 'direct',
): Promise<string> {
  if (!isSafeRevision(base) || !isSafeRevision(head))
    return ''

  const range = mode === 'merge-base' ? `${base}...${head}` : `${base}..${head}`

  const result = await runGit(repositoryPath, [
    'diff',
    '--unified=3',
    '--find-renames',
    '--find-copies',
    '--no-color',
    '--no-ext-diff',
    range,
  ], { timeoutMs: 60_000 })

  return result.ok ? result.stdout : ''
}

/** How many lines of one file may be blamed in a single request. */
export const MAX_BLAME_LINES = 5000

export interface BlameResult {
  ok: boolean
  lines: BlameLine[]
  truncated: boolean
  error: string | null
}

/**
 * Who last touched each line of a file.
 *
 * Capped, because blame is the most expensive thing in the browser: git walks
 * history per line, and a minified bundle checked in years ago is both the
 * slowest case and the one nobody wants the answer to. The cap is applied as a
 * line range so git does the work for the lines that are asked for rather than
 * for the whole file and then being truncated here.
 */
export async function blameFile(
  repositoryPath: string,
  ref: string,
  path: string,
  limit = MAX_BLAME_LINES,
): Promise<BlameResult> {
  if (!isSafeRevision(ref))
    return { ok: false, lines: [], truncated: false, error: 'Invalid ref' }

  if (!path)
    return { ok: false, lines: [], truncated: false, error: 'No path given' }

  const capped = Math.max(1, Math.min(limit, MAX_BLAME_LINES))

  const result = await runGit(repositoryPath, [
    'blame',
    '--porcelain',
    '-L',
    `1,${capped}`,
    ref,
    '--',
    path,
  ])

  // git refuses a range past the end of a short file, which is not an error
  // anybody asked about: retry unbounded, since the file is smaller than the
  // cap by definition.
  if (!result.ok) {
    const whole = await runGit(repositoryPath, ['blame', '--porcelain', ref, '--', path])
    if (!whole.ok)
      return { ok: false, lines: [], truncated: false, error: 'No such file at that ref' }

    const lines = parseBlame(whole.stdout)
    return { ok: true, lines: lines.slice(0, capped), truncated: lines.length > capped, error: null }
  }

  const lines = parseBlame(result.stdout)

  return { ok: true, lines, truncated: lines.length >= capped, error: null }
}

/** Shared by `commitHistory` and `compareRefs`, which ask for the same format. */
function parseCommitRecords(stdout: string): CommitSummary[] {
  return stdout
    .split('\x1e')
    .map(record => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [sha, subject, authorName, when] = record.split('\0')
      return { sha: sha ?? '', subject: subject ?? '', authorName: authorName ?? '', when: when ?? '' }
    })
    .filter(commit => commit.sha.length > 0)
}
