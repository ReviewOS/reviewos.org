import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { coerced } from '../inputs'
import { authorizeRepository } from '../Repo/authorize'
import { forgeResponse, forgeResult, ForgeError } from '../Support/forge'
import { saveWikiPage, wikiPage, wikiSlug } from './wiki'

export default new Action({
  name: 'DeleteWiki', method: 'POST', description: 'Remove a wiki page while preserving its revision history',
  validations: { revision: { rule: coerced } },
  async handle(request: RequestInstance) {
    return forgeResponse(async () => {
      const auth = await authorizeRepository(request, 'wiki:write')
      if (!auth.ok)
        return response.json({ error: auth.error }, auth.status)
      const slug = wikiSlug(request.getParam('slug'))
      const previous = await wikiPage(Number(auth.context.repository.id), slug)
      if (!previous)
        throw new ForgeError('No such wiki page', 404)
      await saveWikiPage(Number(auth.context.repository.id), auth.context.user!.id, slug, { title: previous.title, body: previous.body, revision: request.get('revision'), summary: 'Deleted page', remove: true })
      return forgeResult(request, { deleted: true }, `/${request.getParam('owner')}/${auth.context.repository.name}/wiki`)
    })
  },
})
