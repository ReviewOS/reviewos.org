import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { authorizeRepository } from '../Repo/authorize'
import { forgeResponse, pageOffset, positiveId } from '../Support/forge'
import { projectBoard } from './projects'

export default new Action({
  name: 'ShowProject', method: 'GET', description: 'Read a project board and its linked issues and pull requests',
  async handle(request: RequestInstance) {
    return forgeResponse(async () => {
      const auth = await authorizeRepository(request, 'project:read')
      if (!auth.ok)
        return response.json({ error: auth.error }, auth.status)
      return response.json(await projectBoard(Number(auth.context.repository.id), positiveId(request.getParam('project')), String(request.get('q') ?? ''), String(request.get('state') ?? ''), pageOffset(request.get('offset'))))
    })
  },
})
