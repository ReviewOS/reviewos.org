import { Action } from '@stacksjs/actions'
import { browseContext, browsePath } from './context'
import { commitHistory } from './load'

/** How many commits one request may ask for. */
const MAX_LIMIT = 100

/**
 * History at a ref, newest first, optionally scoped to a path.
 *
 * Paged by `before` rather than by offset. History is append-only at the tip:
 * a push while somebody is on page three shifts every commit down by one, and
 * an offset then shows them a commit they have already seen and skips one they
 * have not. A sha is a fixed point in the history no push can move.
 */
export default new Action({
  name: 'BrowseCommits',
  description: 'List commits at a ref',
  method: 'GET',

  async handle(request: RequestInstance) {
    const browse = await browseContext(request)
    if (!browse.ok)
      return response.json({ error: browse.error }, browse.status)

    const path = browsePath(request.get('path'))
    if (path === null)
      return response.json({ error: 'That path cannot be used' }, 422)

    const requested = Number(request.get('limit') ?? 30)
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(requested, MAX_LIMIT)) : 30

    const { diskPath, ref } = browse.context
    const before = String(request.get('before') ?? '').trim()

    // One extra, so the answer knows whether there is another page without a
    // second query.
    const commits = await commitHistory(diskPath, before || ref, path, limit + 1)
    const page = commits.slice(0, limit)

    return response.json({
      ref,
      path,
      commits: page,
      // The cursor is the first commit of the *next* page, so following it
      // starts exactly where this one stopped.
      next: commits.length > limit ? commits[limit]!.sha : null,
    })
  },
})
