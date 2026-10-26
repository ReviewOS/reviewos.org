import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { authorizeRepository } from '../Repo/authorize'
import { registryConfigured, registryPackages } from './pantry'
import { pageOffset } from '../Support/forge'

export default new Action({
  name: 'ListPackages', method: 'GET', description: 'List the packages owned by a repository',
  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'package:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)
    const offset = pageOffset(request.get('offset'))
    const packages = await registryPackages(Number(auth.context.repository.id), offset)
    return response.json({ configured: registryConfigured(), packages: packages.slice(0, 100), next_offset: packages.length > 100 ? offset + 100 : null })
  },
})
