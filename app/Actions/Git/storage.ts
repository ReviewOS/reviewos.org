/**
 * Where repositories live on disk, and how a request path becomes one.
 *
 * Every path that touches a repository comes through here. Nothing else in the
 * codebase should know the layout, so moving it later is one change rather than
 * a search.
 *
 * The layout is `storage/repos/{owner}/{name}.git`: ordinary bare repositories,
 * readable by any git client, so nothing about the data is locked inside this
 * application.
 *
 * The path builder is the security boundary for the git endpoints. An owner or
 * repository name arrives from a URL, and a name like `../..` would otherwise
 * reach outside the repository root entirely. Names are validated against an
 * allowlist rather than filtered, because filtering is a guess about which
 * encodings the filesystem will collapse.
 */

import { join, resolve } from 'node:path'

/** Root of every repository on disk, relative to the project. */
export const REPOSITORY_ROOT = 'storage/repos'

export type PathRejection = 'empty' | 'invalid-characters' | 'reserved' | 'traversal'

export interface RepositoryPathResult {
  ok: boolean
  /** Absolute path to the bare repository, when valid. */
  path?: string
  /** Path relative to the repository root, which is what the model stores. */
  relative?: string
  reason?: PathRejection
}

/**
 * A single path segment: an owner handle or a repository name.
 *
 * Deliberately narrower than what a filesystem allows. `.` and `..` are the
 * traversal cases, but a leading dot also hides a directory and a name
 * containing a slash is two segments pretending to be one.
 */
export function isSafeSegment(segment: string): boolean {
  if (segment.length === 0 || segment.length > 100)
    return false

  if (segment === '.' || segment === '..')
    return false

  if (segment.startsWith('.'))
    return false

  return /^[A-Za-z0-9._-]+$/.test(segment)
}

/**
 * Resolve an owner and repository name to a bare repository path.
 *
 * Returns a rejection rather than throwing: these values come from a URL, and a
 * bad one is a 404, not a crash.
 */
export function repositoryPath(owner: string, name: string, root = REPOSITORY_ROOT): RepositoryPathResult {
  const repoName = name.replace(/\.git$/, '')

  if (owner.length === 0 || repoName.length === 0)
    return { ok: false, reason: 'empty' }

  if (!isSafeSegment(owner) || !isSafeSegment(repoName))
    return { ok: false, reason: 'invalid-characters' }

  const relative = join(owner, `${repoName}.git`)
  const absoluteRoot = resolve(root)
  const absolute = resolve(absoluteRoot, relative)

  // Belt and braces: even with both segments validated, the resolved path must
  // still sit under the root. If these two ever disagree, the allowlist above
  // is the thing that is wrong.
  if (!absolute.startsWith(`${absoluteRoot}/`))
    return { ok: false, reason: 'traversal' }

  return { ok: true, path: absolute, relative }
}

/**
 * The repository on local disk, ready to be served.
 *
 * Today this is `repositoryPath` with a check that the directory is really
 * there, and that is the entire point: it is a seam, adopted now while it is
 * behavior-neutral so that adopting it is not also the change that could break
 * something.
 *
 * **What it becomes** (phase 18c, which waits on phase 17's MySQL): disk stops
 * being the truth and becomes a cache. A repository that is missing on this
 * node, or whose refs have drifted from the database ledger, is materialized
 * from its checkpoint bundle plus the WAL suffix before it is served. Every
 * caller that goes through here gets that for free; every caller that kept
 * calling `repositoryPath` directly would serve a stale repository and look
 * like it worked, which is the failure this codebase has been bitten by often
 * enough to name in its own roadmap.
 *
 * So the rule is: **anything that is about to hand a path to git asks here.**
 * `repositoryPath` stays for the callers that want to know where a repository
 * *would* live - creating one, moving one aside, reporting a path.
 *
 * Async from the first commit, deliberately. Materializing cannot be
 * synchronous, and a seam that changes shape when it grows teeth is a seam
 * every caller has to be revisited for.
 */
export interface LocalRepository {
  ok: boolean
  /** Absolute path to the bare repository, when it is there. */
  path?: string
  relative?: string
  /** Why not, for the caller to turn into a 404 or a refusal. */
  reason?: PathRejection | 'missing'
}

export async function ensureLocal(owner: string, name: string, root = REPOSITORY_ROOT): Promise<LocalRepository> {
  const resolved = repositoryPath(owner, name, root)

  if (!resolved.ok)
    return { ok: false, reason: resolved.reason }

  // `HEAD` rather than the directory: a directory that exists but holds no
  // repository is the shape an interrupted clone leaves behind, and phase 16
  // had to fix exactly that in the mirror import. git's own marker is the
  // honest test.
  const marker = Bun.file(join(resolved.path!, 'HEAD'))

  if (!(await marker.exists()))
    return { ok: false, reason: 'missing', relative: resolved.relative }

  return { ok: true, path: resolved.path, relative: resolved.relative }
}

/**
 * The `{owner}/{name}` pair in a git wire-protocol URL.
 *
 * git asks for `/{owner}/{name}.git/info/refs`, and clients vary on whether
 * they include the `.git`, so both spellings resolve to the same repository.
 */
export function parseGitUrl(pathname: string): { owner: string, name: string, rest: string } | null {
  const trimmed = pathname.replace(/^\/+/, '')
  const parts = trimmed.split('/')

  if (parts.length < 2)
    return null

  const [owner, rawName, ...rest] = parts
  if (!owner || !rawName)
    return null

  return {
    owner,
    name: rawName.replace(/\.git$/, ''),
    rest: rest.join('/'),
  }
}

/**
 * Which git service a request is asking for, or null when it is not a git
 * request at all.
 *
 * Only the two services that exist are accepted. `git-upload-archive` is
 * deliberately absent: it is rarely used and would be another remotely reachable
 * subprocess to reason about.
 */
export function gitService(pathname: string, query: URLSearchParams): 'upload-pack' | 'receive-pack' | null {
  if (pathname.endsWith('/info/refs')) {
    const service = query.get('service')
    if (service === 'git-upload-pack')
      return 'upload-pack'
    if (service === 'git-receive-pack')
      return 'receive-pack'
    return null
  }

  if (pathname.endsWith('/git-upload-pack'))
    return 'upload-pack'

  if (pathname.endsWith('/git-receive-pack'))
    return 'receive-pack'

  return null
}

/** Whether a service only reads. Decides which permission the request needs. */
export function isReadOnlyService(service: 'upload-pack' | 'receive-pack'): boolean {
  return service === 'upload-pack'
}
