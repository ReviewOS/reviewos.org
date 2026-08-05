import { Action } from '@stacksjs/actions'
import { browseContext, browsePath } from './context'
import { listTree } from './load'

/**
 * List a directory at a ref.
 *
 * The reading and the parsing both live in modules the browse view uses too, so
 * the page and the API cannot disagree about what a repository contains - which
 * they could while this action ran its own `ls-tree` and its own permission
 * check next to the view running theirs.
 */
export default new Action({
  name: 'BrowseTree',
  description: 'List a directory in a repository at a ref',
  method: 'GET',

  async handle(request: any) {
    const browse = await browseContext(request)
    if (!browse.ok)
      return response.json({ error: browse.error }, browse.status)

    const path = browsePath(request.get('path'))
    if (path === null)
      return response.json({ error: 'That path cannot be used' }, 422)

    const { diskPath, ref } = browse.context
    const listing = await listTree(diskPath, ref, path)

    if (!listing.ok)
      return response.json({ error: listing.error ?? 'No such path at that ref' }, 404)

    return response.json({ ref, path, entries: listing.entries })
  },
})
