/**
 * What a profile page shows: somebody's repositories, and the page they wrote
 * about themselves.
 *
 * The view used to do all of this inline - one query, thirty rows, no filter,
 * no paging - and an owner with a hundred and fourteen repositories got a flat
 * list of thirty of them in an order nobody chose. The order was the tell:
 * `updated_at` is null on every repository that has been pushed to but never
 * edited through the product, so `ORDER BY updated_at DESC` sorted the whole
 * page by nothing at all.
 *
 * Rules in a template cannot be tested, so they are here, and the pure parts -
 * paging arithmetic, the search pattern - are separated from the queries so
 * they can be tested without a database.
 */

import { raw } from 'bun-query-builder'
import { readBlob } from '../Browse/load'
import { primaryLanguages } from '../Explore/explore'
import { renderMarkdownHighlighted } from '../Markdown/render'
import { repositoryForView } from '../Repo/forView'

/** One repository, as a profile card needs it. */
export interface ProfileRepository {
  name: string
  description: string
  isPrivate: boolean
  isFork: boolean
  isArchived: boolean
  isTemplate: boolean
  stars: number
  forks: number
  /** What most of it is written in, or null where nobody has measured it. */
  language: string | null
  /** When it last did something: pushed, else edited, else created. May be null. */
  activeAt: string | null
}

export interface ProfileRepositories {
  rows: ProfileRepository[]
  /** Everything this reader may see, before the search box narrowed it. */
  total: number
  /** What the search box left. Equal to `total` when nothing was typed. */
  matched: number
  page: number
  pages: number
  perPage: number
  query: string
}

/**
 * How many repositories one page of a profile carries.
 *
 * Twenty-four rather than the thirty this used to cut off at, because they now
 * arrive as a two-column grid and an even number does not leave a card alone on
 * the last row.
 */
export const REPOSITORIES_PER_PAGE = 24

/** How many pages `matched` rows make. Always at least one, so an empty profile still has a page 1. */
export function pageCount(matched: number, perPage: number = REPOSITORIES_PER_PAGE): number {
  if (perPage <= 0)
    return 1

  return Math.max(1, Math.ceil(Math.max(0, matched) / perPage))
}

/** The page actually being shown: whatever was asked for, held inside the range that exists. */
export function clampPage(asked: unknown, pages: number): number {
  const wanted = Math.trunc(Number(asked))

  if (!Number.isFinite(wanted) || wanted < 1)
    return 1

  return Math.min(wanted, Math.max(1, pages))
}

/**
 * A search box's text as a `LIKE` pattern.
 *
 * `%` and `_` are wildcards, so somebody searching for `bun_queue` would
 * otherwise match `bun-queue` too - and a search that quietly means something
 * else than what was typed is worse than one that finds nothing. Escaped with
 * a backslash, which is the default escape character in Postgres, SQLite and
 * MySQL alike.
 *
 * Lowercased here because the comparison is against `LOWER(name)`: repository
 * names carry capitals (`GitHarbor`) and nobody types them.
 */
export function searchPattern(query: string): string {
  const escaped = String(query ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\\%_]/g, match => `\\${match}`)

  return `%${escaped}%`
}

export interface RepositoryQuery {
  ownerId: number
  ownerType: 'user' | 'organization'
  /** Whether this reader may see the owner's private repositories. */
  includePrivate: boolean
  query?: string
  page?: unknown
  perPage?: number
}

/**
 * The owner's repositories, filtered, ordered and cut into one page.
 *
 * Ordered by when the repository last did something rather than by when its row
 * was last written: `pushed_at` first, then `updated_at`, then `created_at`, and
 * never-pushed repositories sink rather than float. That needs one raw fragment
 * because the three columns do not share a type - `pushed_at` is a string,
 * `updated_at` a timestamp - so `COALESCE` over them is a Postgres type error,
 * and `NULLS LAST` is not portable to MySQL. `(pushed_at IS NULL) ASC` is, and
 * says the same thing.
 */
export async function ownerRepositories(input: RepositoryQuery): Promise<ProfileRepositories> {
  const perPage = input.perPage && input.perPage > 0 ? input.perPage : REPOSITORIES_PER_PAGE
  const query = String(input.query ?? '').trim()

  const scope = () => {
    let builder = db
      .selectFrom('repositories')
      .where('owner_type', '=', input.ownerType)
      .where('owner_id', '=', input.ownerId)

    if (!input.includePrivate)
      builder = builder.where('visibility', '=', 'public')

    return builder
  }

  const narrowed = () => {
    const builder = scope()

    if (!query)
      return builder

    // Both halves, because a repository is as often remembered by what it does
    // as by what it is called.
    const pattern = searchPattern(query)

    return builder.whereRaw(raw`(LOWER(name) LIKE ${pattern} OR LOWER(COALESCE(description, '')) LIKE ${pattern})`)
  }

  // Counted by reading ids rather than by an aggregate, which is how the rest of
  // this codebase counts (see `app/Actions/Org/read.ts`). A profile's repository
  // list is a few hundred rows at the outside.
  const [everything, matching]: [any[], any[]] = await Promise.all([
    scope().select(['id']).execute(),
    query ? narrowed().select(['id']).execute() : Promise.resolve([] as any[]),
  ])

  const total = everything.length
  const matched = query ? matching.length : total
  const pages = pageCount(matched, perPage)
  const page = clampPage(input.page, pages)

  const rows: any[] = await narrowed()
    .select(['id', 'name', 'description', 'visibility', 'stars_count', 'forks_count', 'is_fork', 'is_archived', 'is_template', 'pushed_at', 'updated_at', 'created_at'])
    .orderByRaw(raw`(pushed_at IS NULL) ASC, pushed_at DESC, updated_at DESC, created_at DESC`)
    .limit(perPage)
    .offset((page - 1) * perPage)
    .execute()

  // One query for the whole page rather than one per card, and the same read
  // the explore screen uses - so a repository cannot be called TypeScript on one
  // page and nothing on the other.
  const languages = await primaryLanguages(rows.map(row => Number(row.id)))

  return {
    rows: rows.map(row => ({
      name: String(row.name),
      description: String(row.description ?? ''),
      isPrivate: String(row.visibility) !== 'public',
      isFork: Boolean(row.is_fork),
      isArchived: Boolean(row.is_archived),
      isTemplate: Boolean(row.is_template),
      stars: Number(row.stars_count ?? 0) || 0,
      forks: Number(row.forks_count ?? 0) || 0,
      language: languages.get(Number(row.id)) ?? null,
      activeAt: lastActive(row),
    })),
    total,
    matched,
    page,
    pages,
    perPage,
    query,
  }
}

/** When a repository row last did anything, in the order that means something. */
function lastActive(row: any): string | null {
  const candidate = row.pushed_at ?? row.updated_at ?? row.created_at
  if (!candidate)
    return null

  const at = new Date(String(candidate))

  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

/**
 * The file an owner's profile page is written in.
 *
 * GitHub keeps this in a repository called `.github`, at `profile/README.md`,
 * and a user's own profile in a repository named after them. The dot cannot
 * survive here - repository names are a path segment on disk, and a leading dot
 * is rejected by `app/Actions/Git/storage.ts` precisely so a name cannot hide a
 * directory or climb out of the repository root - so `buddy mirror:add` drops
 * it, and an organization's `.github` mirrors as `github`. That repository is
 * read first, which is what makes an instance mirroring an organization show
 * the same profile page the organization publishes upstream.
 *
 * So one rule covers both kinds of owner, which is the same choice the profile
 * route itself makes: **the repository named after the handle**, and inside it
 * `profile/README.md` before `README.md`. The `profile/` file is what an
 * organization writes - `stacks/stacks` is the framework, and its own README
 * belongs to the framework rather than to the organization page - while a
 * person whose namesake repository *is* their profile gets the shorter path
 * that GitHub taught them.
 *
 * Read through `repositoryForView`, so a private namesake repository is not a
 * way to publish a profile page to people who may not see it.
 */
export const PROFILE_README_PATHS = ['profile/README.md', 'README.md'] as const

/**
 * The repositories a profile page may be written in, in the order they are read.
 *
 * An organization's `.github`, mirrored here as `github`, comes first: it is
 * where the upstream organization already keeps the page, and where a mirror
 * will keep it current without anybody copying anything. The repository named
 * after the handle is the native place to write one on an instance that mirrors
 * nothing.
 */
export function profileRepositoriesFor(handle: string, isOrganization: boolean): string[] {
  const owner = String(handle ?? '').toLowerCase()

  return isOrganization ? ['github', owner] : [owner]
}

/**
 * Which of them an owner may write their profile in.
 *
 * An organization gets `profile/README.md` only. `stacks/stacks` is the
 * framework and its README is the framework's - rendering it on the
 * organization page would put a project's install instructions under a heading
 * that says who these people are, which is exactly what GitHub avoids by
 * keeping the organization page in a repository of its own.
 */
export function readmePathsFor(isOrganization: boolean): readonly string[] {
  return isOrganization ? [PROFILE_README_PATHS[0]] : PROFILE_README_PATHS
}

export interface ProfileReadme {
  html: string
  /** Where it came from, so the page can link to the file itself. */
  repository: string
  path: string
}

export async function profileReadme(handle: string, isOrganization: boolean, cookies?: unknown): Promise<ProfileReadme | null> {
  const owner = String(handle ?? '').toLowerCase()
  if (!owner)
    return null

  for (const repository of profileRepositoriesFor(owner, isOrganization)) {
    const access = await repositoryForView(owner, repository, cookies as any)
    const diskPath = String(access?.diskPath ?? '')

    if (!access?.repository || !diskPath)
      continue

    const ref = String((access.repository as any).default_branch || 'HEAD')

    for (const path of readmePathsFor(isOrganization)) {
      const blob = await readBlob(diskPath, ref, path)

      if (!blob.ok || blob.binary || blob.tooLarge || !blob.text)
        continue

      // Rendered here rather than in the template: `@markdown` runs before
      // interpolation, so it would render the literal token and drop the file's
      // text into the page untouched - and this file is written by whoever owns
      // the handle. `renderMarkdownHighlighted` is where the sanitising lives.
      return {
        html: await renderMarkdownHighlighted(blob.text, { owner, repository }),
        repository,
        path,
      }
    }
  }

  return null
}
