import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { coerced } from '../inputs'
import { authorizeRepository } from '../Repo/authorize'
import { forgeResponse, forgeResult, ForgeError, positiveId } from '../Support/forge'
import { changeProject, projectUrl } from './projects'

export default new Action({
  name: 'RemoveProjectItem', method: 'POST', description: 'Remove a project card while keeping its issue',
  validations: { revision: { rule: coerced } },
  async handle(request: RequestInstance) {
    return forgeResponse(async () => {
      const auth = await authorizeRepository(request, 'project:move')
      if (!auth.ok)
        return response.json({ error: auth.error }, auth.status)
      const projectId = positiveId(request.getParam('project'))
      const itemId = positiveId(request.getParam('item'))
      await changeProject(Number(auth.context.repository.id), projectId, async (tx) => {
        const item = await tx.selectFrom('project_items').select(['id', 'revision']).where('project_id', '=', projectId).where('id', '=', itemId).executeTakeFirst()
        if (!item)
          throw new ForgeError('No such project card', 404)
        if (positiveId(request.get('revision')) !== Number(item.revision))
          throw new ForgeError('This card changed. Reload before removing it.', 409)
        await tx.deleteFrom('project_items').where('id', '=', itemId).execute()
      })
      return forgeResult(request, { removed: true }, projectUrl(request, projectId))
    })
  },
})
