import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { authorizeRepository } from '../Repo/authorize'
import { wikiPages } from './wiki'
import { pageOffset } from '../Support/forge'

export default new Action({
  name: 'ListWiki', method: 'GET', description: 'List Markdown wiki pages',
  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'wiki:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)
    const offset = pageOffset(request.get('offset'))
    const pages = await wikiPages(Number(auth.context.repository.id), offset)
    return response.json({ pages: pages.slice(0, 100).filter(page => !page.is_deleted), next_offset: pages.length > 100 ? offset + 100 : null })
  },
})
