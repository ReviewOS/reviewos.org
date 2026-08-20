import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
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

  // Declared so the document can publish them: every key is one the handler
  // reads, and none is required, because this describes the inputs rather than
  // changing what the endpoint accepts.
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    ref: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const browse = await browseContext(request)
    if (!browse.ok)
      return response.json({ error: browse.error }, browse.status)

    return response.json({ tags: await tagNames(browse.context.diskPath) })
  },
})
