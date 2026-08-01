/**
 * Helpers the repository browse screen needs.
 *
 * Exported from `resources/functions`, so stx auto-imports them and the
 * template stays free of logic that would be untestable inside a template.
 * Nothing here touches the database or spawns git: it takes what an action
 * already fetched and shapes it for display.
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

/**
 * Directories first, then files, each alphabetically.
 *
 * git returns tree order, which is byte order over a normalised name and puts
 * directories wherever their name falls. Every file browser people have used
 * groups directories at the top, and matching that is worth more than matching
 * git's internal ordering.
 */
export function sortEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.type === 'tree'
    const bDir = b.type === 'tree'
    if (aDir !== bDir) return aDir ? -1 : 1
    return a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' })
  })
}

/** A file size for humans. Trees show nothing rather than `0 B`, which reads as an empty file. */
export function formatSize(size: number | null): string {
  if (size === null) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export interface Crumb {
  name: string
  /** Path this crumb navigates to, empty for the repository root. */
  path: string
  /** The last crumb is where you are, so it is not a link. */
  current: boolean
}

/**
 * The trail back to the repository root.
 *
 * Each crumb carries the full path to itself rather than its own segment, since
 * that is what a link needs and rebuilding it in the template would put string
 * joining in a place that cannot be tested.
 */
export function breadcrumbs(repositoryName: string, path: string): Crumb[] {
  const segments = path.split('/').filter(Boolean)
  const crumbs: Crumb[] = [{ name: repositoryName, path: '', current: segments.length === 0 }]

  let accumulated = ''
  segments.forEach((segment, index) => {
    accumulated = accumulated ? `${accumulated}/${segment}` : segment
    crumbs.push({
      name: segment,
      path: accumulated,
      current: index === segments.length - 1,
    })
  })

  return crumbs
}

/**
 * The README to render under the tree, if there is one.
 *
 * Case-insensitive because repositories disagree (`README.md`, `readme.md`,
 * `Readme.md`), and a browser that only recognises one spelling shows nothing
 * on repositories that are perfectly conventional.
 */
export function findReadme(entries: readonly TreeEntry[]): TreeEntry | null {
  const candidates = entries.filter(e => e.type === 'blob' && /^readme(\.(md|markdown|txt))?$/i.test(e.name))
  if (candidates.length === 0) return null

  // Prefer markdown when a repository ships several, since that is the one
  // meant to be rendered.
  const markdown = candidates.find(e => /\.(md|markdown)$/i.test(e.name))
  return markdown ?? candidates[0]!
}

/** Whether a path should be rendered as markdown rather than shown as source. */
export function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path)
}

/**
 * Join a directory and a name into a repository-relative path.
 *
 * Kept here so no template has to decide whether it needs the slash, which is
 * how a browser ends up linking to `//src` or `srcindex.ts`.
 */
export function childPath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name
}

/** A short sha, the length git itself uses for display. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/*
 * The app -> view boundary.
 *
 * stx cannot parse `export ... from`, so each server-side helper is imported
 * under an alias and re-exported as a const. Same reason `resources/functions`
 * exists at all: the template gets one import and no logic.
 */
import { branchNames as branchNamesImpl, lastCommit as lastCommitImpl, listTree as listTreeImpl, MAX_BLOB_BYTES as MAX_BLOB_BYTES_IMPL, readBlob as readBlobImpl } from '../../app/Actions/Browse/load'
import { highlightLines as highlightLinesImpl, languageFor as languageForImpl } from '../../app/Actions/Browse/highlight'

export const listTree = listTreeImpl
export const readBlob = readBlobImpl
export const lastCommit = lastCommitImpl
export const branchNames = branchNamesImpl
export const highlightLines = highlightLinesImpl
export const languageFor = languageForImpl
export const MAX_BLOB_BYTES = MAX_BLOB_BYTES_IMPL
