import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { schema } from '@stacksjs/validation'
import { authorizeRepository } from '../Repo/authorize'
import { forgeResponse, forgeResult } from '../Support/forge'
import { saveWikiPage, wikiSlug } from './wiki'

export default new Action({
  name: 'CreateWiki', method: 'POST', description: 'Create a Markdown wiki page',
  validations: { title: { rule: schema.string().required().max(160) }, slug: { rule: schema.string() }, body: { rule: schema.string() }, summary: { rule: schema.string().max(255) } },
  async handle(request: RequestInstance) {
    return forgeResponse(async () => {
      const auth = await authorizeRepository(request, 'wiki:write')
      if (!auth.ok)
        return response.json({ error: auth.error }, auth.status)
      const slug = wikiSlug(request.get('slug') || request.get('title'))
      const page = await saveWikiPage(Number(auth.context.repository.id), auth.context.user!.id, slug, { title: request.get('title'), body: request.get('body'), revision: 0, summary: request.get('summary') })
      return forgeResult(request, page, `/${request.getParam('owner')}/${auth.context.repository.name}/wiki/${slug}`, 201)
    })
  },
})
