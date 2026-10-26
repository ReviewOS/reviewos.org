import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { authorizeRepository } from '../Repo/authorize'
import { forgeResponse, ForgeError } from '../Support/forge'
import { packageName, packagePath, packageVersion, pantryRequest, requirePackage } from './pantry'

export default new Action({
  name: 'DownloadPackage', method: 'GET', description: 'Download a Pantry artifact through repository access control',
  async handle(request: RequestInstance) {
    return forgeResponse(async () => {
      const auth = await authorizeRepository(request, 'package:read')
      if (!auth.ok)
        return response.json({ error: auth.error }, auth.status)
      const name = packageName(`${request.getParam('scope')}/${request.getParam('package')}`)
      const version = packageVersion(request.getParam('version'))
      await requirePackage(Number(auth.context.repository.id), name)
      const answer = await pantryRequest(`/packages/${packagePath(name)}/${version}/tarball`)
      if (!answer.ok) {
        await answer.body?.cancel()
        throw new ForgeError(answer.status === 404 ? 'No such package version' : 'The registry download failed', answer.status === 404 ? 404 : 502)
      }
      const headers = new Headers({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${name.split('/')[1]}-${version}.tgz"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' })
      for (const key of ['Content-Length', 'ETag']) {
        const value = answer.headers.get(key)
        if (value)
          headers.set(key, value)
      }
      return new Response(answer.body, { headers })
    })
  },
})
