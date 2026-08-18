import { Action } from '@stacksjs/actions'
import { authorizeRepository } from '../Repo/authorize'
import { PATH_LIMIT, pullRequestFor, setFileViewed } from './reviewState'

/**
 * Mark one file read, or unmark it.
 *
 * `repository:read` rather than `pull:review`: this is a note the reader makes
 * to themselves about where they are, and somebody reading a public pull
 * request they have no write access to is exactly who benefits from it most.
 *
 * The path is not checked against the diff. Doing so would mean running `git
 * diff` on every tick to answer a question nobody is asking - the worst a wrong
 * path can do is take up a row in the caller's own table, and a rename between
 * the page loading and the box being ticked is an ordinary reason for one.
 */
export default new Action({
  name: 'MarkFileViewed',
  description: 'Mark a file in a pull request as viewed, or not',
  method: 'PUT',

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const pullRequest = await pullRequestFor(repository.id, Number(request.get('number')))
    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    const path = String(request.get('path') ?? '').trim()
    if (!path || path.length > PATH_LIMIT)
      return response.json({ error: 'A viewed mark needs a file' }, 422)

    // Absent means ticked. Unticking is the deliberate act, and it says so.
    const raw = request.get('viewed')
    const viewed = raw === undefined ? true : raw !== false && raw !== 'false' && raw !== 0 && raw !== '0'

    await setFileViewed(pullRequest.id, user.id, path, viewed, pullRequest.head_sha)

    return response.json({ path, viewed, head_sha: viewed ? pullRequest.head_sha : null })
  },
})
