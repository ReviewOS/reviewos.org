import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { originFor } from '../Repo/cloneUrl'
import { authorizeRepository } from '../Repo/authorize'
import { forgeResponse } from '../Support/forge'
import { packageName, packagePath, packageVersion, pantryJson, publicMetadata, registryBase, requirePackage } from './pantry'

export default new Action({
  name: 'ShowPackage', method: 'GET', description: 'Read Pantry package metadata or its immutable version list',
  async handle(request: RequestInstance) {
    return forgeResponse(async () => {
      const auth = await authorizeRepository(request, 'package:read')
      if (!auth.ok)
        return response.json({ error: auth.error }, auth.status)
      const name = packageName(`${request.getParam('scope')}/${request.getParam('package')}`)
      await requirePackage(Number(auth.context.repository.id), name)
      const version = request.getParam('version')
      const suffix = version === 'versions' ? '/versions' : version ? `/${packageVersion(version)}` : ''
      const metadata = await pantryJson(`/packages/${packagePath(name)}${suffix}`)
      const base = `${originFor(request)}${registryBase(request)}`
      return response.json(version === 'versions' ? metadata : publicMetadata(metadata, base))
    })
  },
})
