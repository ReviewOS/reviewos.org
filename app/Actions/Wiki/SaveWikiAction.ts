import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { schema } from '@stacksjs/validation'
import { coerced } from '../inputs'
import { authorizeRepository } from '../Repo/authorize'
import { forgeResponse, forgeResult } from '../Support/forge'
import { saveWikiPage, wikiSlug } from './wiki'

export default new Action({
  name: 'SaveWiki', method: 'POST', description: 'Save or restore a wiki page with an edit summary and revision check',
  validations: { title: { rule: schema.string().required().max(160) }, body: { rule: schema.string() }, revision: { rule: coerced }, summary: { rule: schema.string().max(255) } },
  async handle(request: RequestInstance) {
    return forgeResponse(async () => {
      const auth = await authorizeRepository(request, 'wiki:write')
      if (!auth.ok)
        return response.json({ error: auth.error }, auth.status)
      const slug = wikiSlug(request.getParam('slug'))
      const page = await saveWikiPage(Number(auth.context.repository.id), auth.context.user!.id, slug, {
        title: request.get('title'), body: request.get('body'), revision: request.get('revision'), summary: request.get('summary'),
      })
      return forgeResult(request, page, `/${request.getParam('owner')}/${auth.context.repository.name}/wiki/${slug}`, page.revision === 1 ? 201 : 200)
    })
  },
})
