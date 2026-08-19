/**
 * Repository storage, exposed to views.
 *
 * Re-exported one name at a time rather than with `export … from`, which stx
 * cannot parse.
 */

import { repositoryPath as repositoryPathImpl } from '../../app/Actions/Git/storage'

export const repositoryPath = repositoryPathImpl

/**
 * Resolve `{owner}/{repository}` to the row it names.
 *
 * By owner *and* name, which is the whole point. Two people may each have a
 * repository called `checkout`, and a lookup on the name alone returns
 * whichever was created first: the page then renders one owner's pull request
 * under the other's URL, and every sha on it belongs to a repository the diff
 * is not being read from. That shipped, and the symptom was a review screen
 * reporting no changes rather than anything that looked like a mix-up.
 */
import { findRepositoryByPath as findRepositoryByPathImpl } from '../../app/Actions/Git/access'

export const findRepositoryByPath = findRepositoryByPathImpl

/**
 * The repository a page is about, with the reader's standing on it.
 *
 * What a view should call instead of querying `repositories` itself. Returns
 * null for a repository that does not exist and for one the reader may not see,
 * which are deliberately the same answer.
 */
import { repositoryForView as repositoryForViewImpl } from '../../app/Actions/Repo/forView'

export const repositoryForView = repositoryForViewImpl

/**
 * The URL somebody clones with, from the request the page is answering.
 *
 * See `app/Actions/Repo/cloneUrl.ts` for why the request wins over
 * configuration.
 */
import { cloneUrlFor as cloneUrlForImpl } from '../../app/Actions/Repo/cloneUrl'
import { sshCloneUrlFor as sshCloneUrlForImpl } from '../../app/Actions/Repo/cloneUrl'

export const cloneUrlFor = cloneUrlForImpl

/** Null when no SSH daemon is configured, which is how the box knows to hide it. */
export const sshCloneUrlFor = sshCloneUrlForImpl

/**
 * What a new repository can be started with: a licence, and an ignore file.
 * The lists are in `app/Actions/Repo/scaffold.ts`, which is what the create
 * endpoint reads, so the page cannot offer one the endpoint does not know.
 */
import { GITIGNORES as GITIGNORES_IMPL, LICENSES as LICENSES_IMPL } from '../../app/Actions/Repo/scaffold'

export const LICENSES = LICENSES_IMPL
export const GITIGNORES = GITIGNORES_IMPL

/**
 * Whether a commit's signature checked out, and who signed it.
 *
 * The database half of `app/Actions/Git/verify.ts`, which is deliberately free
 * of one so its rules can be tested against a fixture repository.
 */
import { verifySignature as verifySignatureImpl } from '../../app/Actions/Git/signatures'

export const verifySignature = verifySignatureImpl

/**
 * The keys an account has registered, shaped for the settings page.
 *
 * See `app/Actions/Keys/load.ts` for why the public key body is not among them.
 */
import { hasExpired as hasExpiredImpl, keysFor as keysForImpl } from '../../app/Actions/Keys/load'

export const keysFor = keysForImpl
export const hasExpired = hasExpiredImpl

/** A repository's deploy keys, for its settings page. */
import { deployKeysFor as deployKeysForImpl } from '../../app/Actions/Keys/load'

export const deployKeysFor = deployKeysForImpl

/**
 * The tokens an account holds, described rather than listed.
 *
 * See `app/Actions/Tokens/load.ts` for why the page gets sentences and the API
 * gets scope strings.
 */
import { scopableRepositories as scopableRepositoriesImpl, tokensFor as tokensForImpl } from '../../app/Actions/Tokens/load'

export const tokensFor = tokensForImpl
export const scopableRepositories = scopableRepositoriesImpl

/**
 * The mirror summary for a repository, or null when it is not one.
 *
 * A page's real question about a mirror is whether what it is showing is
 * current - `app/Actions/Mirror/status.ts` has the reasoning.
 */
import { summarize as summarizeMirrorImpl } from '../../app/Actions/Mirror/status'

export const summarizeMirror = summarizeMirrorImpl

/** The mirror row for a repository, read where a view can reach it. */
export async function mirrorFor(repositoryId: number): Promise<any | null> {
  if (!repositoryId)
    return null

  return await db
    .selectFrom('repository_mirrors')
    .selectAll()
    .where('repository_id', '=', repositoryId)
    .executeTakeFirst() ?? null
}

/**
 * Running a search from a page.
 *
 * The same `runSearch` the JSON endpoint calls, so the page and the API cannot
 * answer the same question differently. See `app/Actions/Search/run.ts`.
 */
import { runSearch as runSearchImpl, SEARCHABLE_SCOPES as SEARCHABLE_SCOPES_IMPL } from '../../app/Actions/Search/run'

export const runSearch = runSearchImpl
export const SEARCHABLE_SCOPES = SEARCHABLE_SCOPES_IMPL

/**
 * Where a reader stands with a repository - starred, watching, and how many
 * others - and the header controls that say so.
 *
 * See `app/Actions/Repo/standing.ts`: the shaping is pure and tested there,
 * because what a button says is a rule and a rule in a template is a rule no
 * test can reach.
 */
import { repositoryActions as repositoryActionsImpl, standingFor as standingForImpl } from '../../app/Actions/Repo/standing'

export const standingFor = standingForImpl
export const repositoryActions = repositoryActionsImpl

/**
 * The header controls for one repository page, from what every one of those
 * pages already has.
 *
 * Twelve screens draw `RepoHeader`, and a star button that appears on the code
 * page and vanishes on the issues page teaches a reader that the repository
 * changed - the same failure the tab bar had before it was made one component.
 * So this takes the `repositoryForView` result directly and each page is one
 * line, rather than each page re-deriving the viewer, the counts and the
 * labels and three of them getting it slightly differently.
 *
 * Null for a repository that did not resolve, which is how the header knows to
 * draw nothing: a control that cannot say whether it has been pressed is worse
 * than no control.
 */
export async function repositoryHeaderActions(
  access: any,
  owner: unknown,
  repository: unknown,
  path?: string,
): Promise<any | null> {
  const row = access?.repository ?? null
  if (!row)
    return null

  const standing = await standingForImpl(row.id, access?.viewer?.id ?? null)

  return repositoryActionsImpl(standing, {
    owner: String(owner ?? ''),
    repository: String(repository ?? ''),
    path,
    signedIn: Boolean(access?.viewer),
  })
}

/**
 * The panel beside the file list: description, topics, health files, counts,
 * languages and the latest release.
 *
 * See `app/Actions/Repo/about.ts` - almost all of it is data this instance
 * already had and never showed anybody.
 */
import { aboutFor as aboutForImpl, filesIn as filesInImpl } from '../../app/Actions/Repo/about'

export const aboutFor = aboutForImpl
export const filesIn = filesInImpl
