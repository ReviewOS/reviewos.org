/**
 * Helpers the repository browse screen needs.
 *
 * Exported from `resources/functions`, so stx auto-imports them and the
 * template stays free of logic that would be untestable inside a template.
 * Nothing here touches the database or spawns git: it takes what an action
 * already fetched and shapes it for display.
 */

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
import type { TreeEntry as TreeEntryImpl } from '../../app/Actions/Browse/parse'
import { branchNames as branchNamesImpl, commitHistory as commitHistoryImpl, lastCommit as lastCommitImpl, listTree as listTreeImpl, MAX_BLOB_BYTES as MAX_BLOB_BYTES_IMPL, readBlob as readBlobImpl, tagNames as tagNamesImpl } from '../../app/Actions/Browse/load'
import { highlightLines as highlightLinesImpl, languageFor as languageForImpl } from '../../app/Actions/Browse/highlight'
// The list helpers. Every import in this file has to sit in this one block:
// an `import` further down, after the `export const` re-bindings, is not
// hoisted by stx's server-script transform, and every name from it arrives
// undefined inside a component.
import { authorIsLocal as authorIsLocalImpl, authorLabel as authorLabelImpl, countLabel as countLabelImpl, filterHref as filterHrefImpl, lastPage as lastPageImpl, listFilter as listFilterImpl, PAGE_SIZE as PAGE_SIZE_IMPL, pageHref as pageHrefImpl, pageNumber as pageNumberImpl, pageOffset as pageOffsetImpl, statePill as statePillImpl, stateLabel as stateLabelImpl, statesFor as statesForImpl } from '../../app/Actions/Browse/lists'

/** The tree entry shape, so this file's own signatures can name it. */
type TreeEntry = TreeEntryImpl

export const listTree = listTreeImpl
export const readBlob = readBlobImpl
export const lastCommit = lastCommitImpl
export const branchNames = branchNamesImpl
export const tagNames = tagNamesImpl
export const commitHistory = commitHistoryImpl
export const highlightLines = highlightLinesImpl
export const languageFor = languageForImpl
export const MAX_BLOB_BYTES = MAX_BLOB_BYTES_IMPL
export const listFilter = listFilterImpl
export const statesFor = statesForImpl
export const pageNumber = pageNumberImpl
export const pageOffset = pageOffsetImpl
export const lastPage = lastPageImpl
export const stateLabel = stateLabelImpl
export const statePill = statePillImpl
export const authorLabel = authorLabelImpl
export const authorIsLocal = authorIsLocalImpl
export const countLabel = countLabelImpl
export const filterHref = filterHrefImpl
export const pageHref = pageHrefImpl
export const PAGE_SIZE = PAGE_SIZE_IMPL

/**
 * A commit date as something a reader can place at a glance.
 *
 * Relative for anything recent, absolute once "8 months ago" stops being more
 * useful than the date itself.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return ''

  const seconds = Math.floor((now.getTime() - then.getTime()) / 1000)
  if (seconds < 60) return 'just now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`

  const days = Math.floor(hours / 24)
  if (days < 31) return `${days} day${days === 1 ? '' : 's'} ago`

  const months = Math.floor(days / 30)
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`

  // Past a year, the year is the useful fact.
  return then.toISOString().slice(0, 10)
}
