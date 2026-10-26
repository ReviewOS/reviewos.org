import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { schema } from '@stacksjs/validation'
import { authorizeRepository } from '../Repo/authorize'
import { forgeResponse, ForgeError } from '../Support/forge'
import { wikiHtml } from './wiki'

export default new Action({
  name: 'PreviewWiki', method: 'POST', description: 'Preview Markdown with the same safe BunPress renderer used by wiki pages',
  validations: { body: { rule: schema.string() } },
  async handle(request: RequestInstance) {
    return forgeResponse(async () => {
      const auth = await authorizeRepository(request, 'wiki:write')
      if (!auth.ok)
        return response.json({ error: auth.error }, auth.status)
      const body = String(request.get('body') ?? '')
      if (Buffer.byteLength(body) > 60_000)
        throw new ForgeError('Pages allow 60 KB of Markdown')
      return response.json({ html: wikiHtml(body, `/${request.getParam('owner')}/${auth.context.repository.name}/wiki`) })
    })
  },
})
