import { Action } from '@stacksjs/actions'
import { browseContext } from './context'
import { tagNames } from './load'

/**
 * Every tag, newest first.
 *
 * By the date the tag points at rather than alphabetically, because
 * alphabetical order puts v10 between v1 and v2, which is useless on a release
 * list.
 */
export default new Action({
  name: 'BrowseTags',
  description: 'List a repository tags',
  method: 'GET',

  async handle(request: any) {
    const browse = await browseContext(request)
    if (!browse.ok)
      return response.json({ error: browse.error }, browse.status)

    return response.json({ tags: await tagNames(browse.context.diskPath) })
  },
})
