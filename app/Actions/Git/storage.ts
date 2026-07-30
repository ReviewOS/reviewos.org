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
