import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { response } from '@stacksjs/router'
import { authorizeRepository } from '../Repo/authorize'
import { forgeResponse, ForgeError, positiveId } from '../Support/forge'
import { wikiHistory, wikiHtml, wikiPage, wikiSlug } from './wiki'

export default new Action({
  name: 'ShowWiki', method: 'GET', description: 'Read a wiki page, revision history or its Markdown source',
  async handle(request: RequestInstance) {
    return forgeResponse(async () => {
      const auth = await authorizeRepository(request, 'wiki:read')
      if (!auth.ok)
        return response.json({ error: auth.error }, auth.status)
      const slug = wikiSlug(request.getParam('slug'))
      const page = await wikiPage(Number(auth.context.repository.id), slug)
      if (!page)
        throw new ForgeError('No such wiki page', 404)
      const selected = request.get('revision')
        ? await db.selectFrom('wiki_revisions').selectAll().where('wiki_page_id', '=', Number(page.id)).where('revision', '=', positiveId(request.get('revision'))).executeTakeFirst()
        : page
      if (!selected || (selected.is_deleted && !request.get('history')))
        throw new ForgeError('No such wiki revision', 404)
      if (request.get('format') === 'raw')
        return new Response(String(selected.body), { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${slug}.md"`, 'Cache-Control': 'private, no-store' } })
      const base = `/${request.getParam('owner')}/${auth.context.repository.name}/wiki`
      return response.json({ ...selected, slug, html: wikiHtml(String(selected.body), base), history: await wikiHistory(Number(page.id)) })
    })
  },
})
