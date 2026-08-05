/**
 * Resolving a repository for a read, and deciding whether the caller may see
 * it.
 *
 * Every browse endpoint starts the same way: find the repository named in the
 * URL, work out who is asking, and refuse if the two are not allowed to meet.
 * Written once so a new endpoint cannot skip the visibility check, which is the
 * mistake that leaks a private repository - and there are nine of these
 * endpoints, which is eight more chances than anybody should get.
 *
 * Separate from `authorizeRepository` in `app/Actions/Repo/` for one reason: a
 * browse request may arrive with HTTP basic auth rather than a session, because
 * the same token somebody clones with should let them read a file. The session
 * path answers through `currentUser`, which never looks at an `Authorization`
 * header of that shape.
 *
 * A repository the caller may not read is reported as missing rather than
 * forbidden. "You are not allowed to see this" confirms it exists, which is the
 * one thing a private repository must not tell a stranger.
 */

import type { GitRepositoryRow } from '../Git/access'
import type { AuthenticatedToken } from '../Tokens/authenticate'
import { findRepositoryByPath, mayUseService, tokenFromBasicAuth } from '../Git/access'
import { isSafeRevision } from '../Git/git'
import { repositoryPath } from '../Git/storage'
import { currentUser } from '../Identity/lookup'
import { authenticateToken } from '../Tokens/authenticate'

export interface BrowseContext {
  repository: GitRepositoryRow
  /** Absolute path to the bare repository. */
  diskPath: string
  owner: string
  name: string
  /** The requested ref, or the repository's default branch. */
  ref: string
  viewerId: number | null
}

export type BrowseResult =
  | { ok: true, context: BrowseContext }
  | { ok: false, error: string, status: number }

/**
 * Read the repository a browse request names.
 *
 * `ref` defaults to the repository's own default branch rather than to `HEAD`.
 * They are usually the same, and when they are not it is because HEAD is
 * pointing somewhere stale - in which case the row is the one that agrees with
 * what the rest of the interface shows.
 */
export async function browseContext(request: any): Promise<BrowseResult> {
  const owner = String(request.get('owner') ?? '').trim().toLowerCase()
  const name = String(request.get('repository') ?? request.get('repo') ?? '').trim()

  if (!owner || !name)
    return { ok: false, error: 'Not found', status: 404 }

  const repository = await findRepositoryByPath(owner, name)
  if (!repository)
    return { ok: false, error: 'Not found', status: 404 }

  const user = await currentUser(request)
  const token = user ? null : await fineGrainedToken(request)
  const viewerId = user?.id ?? token?.userId ?? null

  // `upload-pack` is the read side of the wire protocol, and browsing is a
  // read. Asking the same question the clone path asks means a repository
  // somebody can clone is a repository they can browse, always.
  //
  // The whole token goes in, not only whose it is. A fine-grained token carries
  // a reach and a set of grants, and passing the user id alone would drop both
  // - a read-only token scoped to one repository would read every repository
  // its owner can, which is the opposite of what scoping it was for.
  if (!(await mayUseService(repository, viewerId, 'upload-pack', token)))
    return { ok: false, error: 'Not found', status: 404 }

  const resolved = repositoryPath(owner, name)
  if (!resolved.ok)
    return { ok: false, error: 'Not found', status: 404 }

  const requested = String(request.get('ref') ?? '').trim()
  const ref = requested || String(repository.default_branch || 'HEAD')

  // Checked here rather than in each caller. A ref reaches git as an argument,
  // and one starting with a dash is an option.
  if (!isSafeRevision(ref))
    return { ok: false, error: 'Invalid ref', status: 422 }

  return {
    ok: true,
    context: { repository, diskPath: resolved.path!, owner, name, ref, viewerId },
  }
}

/**
 * This application's own access token, however it was presented.
 *
 * Basic auth is how git sends it, and a browse request from a script is often
 * the same script that just cloned. Bearer is how everything else sends a
 * token, and refusing it here would mean one credential that works for `curl`
 * on one endpoint and not on the next.
 */
async function fineGrainedToken(request: any): Promise<AuthenticatedToken | null> {
  const header = String(request.headers?.get?.('authorization') ?? '')

  if (header.startsWith('Bearer ')) {
    const result = await authenticateToken(header.slice('Bearer '.length).trim())

    return result.ok ? result.token : null
  }

  return await tokenFromBasicAuth(header || null)
}

/**
 * A path inside a repository, as it arrives from a URL.
 *
 * Leading and trailing slashes are trimmed because `/src/` and `src` name the
 * same directory and nothing downstream should have to know that. `..` is
 * refused rather than resolved: git would interpret it against the tree, which
 * is harmless, but a path that leaves the repository is never what was meant
 * and treating it as an error is how it stays harmless when this value is later
 * used for something else.
 */
export function browsePath(raw: unknown): string | null {
  const path = String(raw ?? '').replace(/^\/+|\/+$/g, '')

  if (!path)
    return ''

  if (path.split('/').some(segment => segment === '..'))
    return null

  // A pathspec beginning with a dash is an option to every git command that
  // takes one.
  if (path.startsWith('-'))
    return null

  return path
}
