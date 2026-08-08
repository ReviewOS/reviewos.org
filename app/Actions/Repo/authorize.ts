/**
 * Resolving `{owner}/{repo}` from a request and deciding what the caller may do
 * with it.
 *
 * Every action below the repository level starts the same way: find the
 * repository, find the caller, work out whether the two are allowed to meet.
 * Written once here so a new action cannot accidentally skip the visibility
 * check, which is the mistake that leaks a private repository.
 */

import type { RepositoryAbility } from '../../Permissions'
import type { AuthenticatedToken } from '../Tokens/authenticate'
import type { GitRepositoryRow } from '../Git/access'
import { allowedOnArchivedRepository, canOnRepository, repositoryPermissionFor } from '../../Permissions'
import { tokenAllows, tokenReaches } from '../../TokenScopes'
import { findRepositoryByPath, permissionOn } from '../Git/access'
import { currentUser } from '../Identity/lookup'
import { authenticateToken } from '../Tokens/authenticate'

export interface RepositoryContext {
  repository: GitRepositoryRow
  user: { id: number, handle: string, is_admin: boolean } | null
  /**
   * The fine-grained token this request carried, when it carried one.
   *
   * Null for a browser session and for a framework token. Actions that meter
   * or attribute per credential read it here rather than re-resolving the
   * header, which is both a wasted query and a second place to get the
   * `ros_`-versus-framework distinction wrong.
   */
  token: AuthenticatedToken | null
  /** The combined permission, or null when the caller cannot see it at all. */
  permission: ReturnType<typeof repositoryPermissionFor>
  can: (ability: RepositoryAbility) => boolean
}

export type AuthorizeResult =
  | { ok: true, context: RepositoryContext }
  | { ok: false, error: string, status: number }

/**
 * Load the repository named by the request and the caller's standing on it.
 *
 * A repository the caller may not read is reported as missing rather than
 * forbidden: "you are not allowed to see this" confirms it exists, which is the
 * one thing a private repository must not tell a stranger.
 */
export async function authorizeRepository(request: any, ability: RepositoryAbility): Promise<AuthorizeResult> {
  const owner = String(request.get('owner') ?? '').trim().toLowerCase()
  const name = String(request.get('repo') ?? request.get('repository') ?? '').trim()

  if (!owner || !name)
    return { ok: false, error: 'Repository not found', status: 404 }

  const repository = await findRepositoryByPath(owner, name)
  if (!repository)
    return { ok: false, error: 'Repository not found', status: 404 }

  /*
   * This project's own fine-grained token, if that is what arrived.
   *
   * `currentUser` deliberately refuses to resolve one - answering "who is this"
   * for a token would drop its reach and its grants, handing a read-only
   * token scoped to one repository everything its owner can do. So it is
   * resolved *here*, where both halves can be applied, which is the only place
   * it is safe to.
   *
   * Until this existed, a fine-grained token authenticated git over HTTP and
   * the browse endpoints and nothing else: every JSON endpoint answered it 401.
   * The credential phase 1 built could not call the API phase 12 built, which
   * is the parity bug in its purest form.
   */
  const presented = await fineGrainedToken(request)
  if (presented === 'rejected')
    return { ok: false, error: 'Unauthenticated', status: 401 }

  const token = presented
  const user = token
    ? await userById(token.userId)
    : await currentUser(request)

  const grants = await permissionOn(repository, user?.id ?? null)

  const input = {
    userId: user?.id ?? null,
    visibility: repository.visibility,
    ownerUserId: repository.owner_type === 'user' ? repository.owner_id : null,
    ...grants,
  }

  if (!canOnRepository(input, 'repository:read'))
    return { ok: false, error: 'Repository not found', status: 404 }

  /*
   * A token narrows, never widens. Both checks apply and the user's runs
   * first, so removing somebody from a repository revokes their token's reach
   * into it without anybody having to remember to revoke the token.
   *
   * A repository outside the token's reach reads as missing, exactly as it
   * would for a stranger: "your token cannot see that one" confirms it exists.
   */
  if (token && !tokenReaches(token.reach, repository))
    return { ok: false, error: 'Repository not found', status: 404 }

  if (!canOnRepository(input, ability))
    return { ok: false, error: user ? 'Forbidden' : 'Unauthenticated', status: user ? 403 : 401 }

  // Here the repository is visible and the person may do it, so naming the
  // missing scope is useful rather than a disclosure - and it is the one thing
  // that turns "403" into a fix.
  if (token && !tokenAllows(token.grants, ability))
    return { ok: false, error: `This token does not carry the ${ability} permission`, status: 403 }

  // Archived is checked after the permission, so a stranger learns nothing:
  // "this repository is archived" from an endpoint they could never have used
  // is still a confirmation that it exists.
  //
  // 409 rather than 403, because the caller is not the problem. They have the
  // permission; the repository is in a state that refuses the change, and the
  // fix is to unarchive rather than to ask somebody for access.
  if (repository.is_archived && !allowedOnArchivedRepository(ability)) {
    return {
      ok: false,
      error: 'This repository is archived. Unarchive it to make changes.',
      status: 409,
    }
  }

  return {
    ok: true,
    context: {
      repository,
      user: user ?? null,
      token,
      permission: repositoryPermissionFor(input),
      // The token narrows this too. An action asking `can('pull:merge')` to
      // decide whether to show an option must get the same answer the merge
      // endpoint would give, or the interface offers something that then fails.
      can: (candidate: RepositoryAbility) =>
        canOnRepository(input, candidate) && (!token || tokenAllows(token.grants, candidate)),
    },
  }
}

/**
 * The next issue or pull request number for a repository.
 *
 * Issues and pull requests share one sequence, because `#12` has to mean one
 * thing. The counter lives on the repository row and is bumped by a conditional
 * update, so two requests arriving together cannot be handed the same number:
 * whichever loses the race sees a different current value and retries.
 */
export async function allocateNumber(repositoryId: number, attempts = 5): Promise<number> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const row = await db
      .selectFrom('repositories')
      .select(['issue_counter'])
      .where('id', '=', repositoryId)
      .executeTakeFirst()

    const current = Number(row?.issue_counter ?? 0)
    const next = current + 1

    const updated = await db
      .updateTable('repositories')
      .set({ issue_counter: next })
      .where('id', '=', repositoryId)
      .where('issue_counter', '=', current)
      .executeTakeFirst()

    if (Number(updated?.numUpdatedRows ?? 0) > 0)
      return next
  }

  throw new Error('Could not allocate a number for this repository')
}

/**
 * The fine-grained token on this request, resolved once and remembered.
 *
 * Only this project's own scheme. A framework token is left to `currentUser`,
 * which is where it has always been handled, and a request carrying neither
 * gets null and the ordinary session path.
 */
async function fineGrainedToken(request: any): Promise<AuthenticatedToken | 'rejected' | null> {
  if (request && '__fineGrainedToken' in request)
    return request.__fineGrainedToken

  let resolved: AuthenticatedToken | 'rejected' | null = null

  try {
    const header = String(
      request?.headers?.get?.('authorization') ?? request?.header?.('authorization') ?? '',
    )

    if (header.startsWith('Bearer ')) {
      const presented = header.slice('Bearer '.length).trim()

      // Only ours. Anything else is somebody else's credential and resolving
      // it here would be guessing.
      if (presented.startsWith('ros_')) {
        const result = await authenticateToken(presented)

        /*
         * A token of ours that does not authenticate is a refusal, not a
         * stranger. Falling through to anonymous means an expired token
         * reading a private repository is answered 404, and somebody spends an
         * afternoon looking for a repository that was there yesterday. 401
         * says the true thing and discloses nothing: it is about the
         * credential, not about what exists.
         *
         * The *reason* stays here. "Expired" and "unknown" are different
         * facts, and telling a stranger which one applies confirms that a
         * token they found used to be real.
         */
        resolved = result.ok ? result.token : 'rejected'
      }
    }
  }
  catch {
    /*
     * An unreadable header is nobody, not an error. The endpoint may well
     * serve a public repository perfectly happily, and failing the request
     * would turn a stale token into an outage rather than a sign-in prompt.
     */
  }

  try {
    if (request)
      request.__fineGrainedToken = resolved
  }
  catch {
    // A frozen request. The lookup simply happens again.
  }

  return resolved
}

/** The user a token belongs to, in the shape the context carries. */
async function userById(id: number): Promise<{ id: number, handle: string, is_admin: boolean } | null> {
  const row = await db
    .selectFrom('users')
    .select(['id', 'handle', 'is_admin'])
    .where('id', '=', id)
    .executeTakeFirst()

  return row ? { id: Number(row.id), handle: String(row.handle), is_admin: Boolean(row.is_admin) } : null
}
