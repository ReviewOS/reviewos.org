import { Action } from '@stacksjs/actions'
import { browseContext } from './context'
import { commitDetail } from './load'

/**
 * One commit, with what it changed.
 *
 * The file list only: no patch. A commit touching four hundred files would
 * otherwise put the whole diff in one response, and the diff endpoints already
 * stream that a file at a time.
 */
export default new Action({
  name: 'BrowseCommit',
  description: 'Read one commit and the files it changed',
  method: 'GET',

  async handle(request: any) {
    const browse = await browseContext(request)
    if (!browse.ok)
      return response.json({ error: browse.error }, browse.status)

    // The commit is named by `sha`, falling back to the ref: `/commit/main`
    // is a reasonable thing to ask for and means the tip.
    const revision = String(request.get('sha') ?? '').trim() || browse.context.ref
    const commit = await commitDetail(browse.context.diskPath, revision)

    if (!commit)
      return response.json({ error: 'No such commit' }, 404)

    return response.json({
      ...commit,
      // Said out loud, because a merge's file list is against its first parent
      // and a caller comparing it to a combined diff would get different
      // numbers without knowing why.
      files_against: commit.isMerge ? 'first-parent' : 'parent',
    })
  },
})
