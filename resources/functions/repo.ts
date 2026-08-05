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
