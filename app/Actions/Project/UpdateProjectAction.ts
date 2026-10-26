import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { schema } from '@stacksjs/validation'
import { coerced } from '../inputs'
import { authorizeRepository } from '../Repo/authorize'
import { forgeResponse, forgeResult, ForgeError, positiveId, titleField } from '../Support/forge'
import { changeProject, projectUrl } from './projects'

export default new Action({
  name: 'UpdateProject', method: 'POST', description: 'Edit, close or reopen a project',
  validations: { title: { rule: schema.string() }, description: { rule: schema.string() }, state: { rule: schema.string() }, revision: { rule: coerced } },
  async handle(request: RequestInstance) {
    return forgeResponse(async () => {
      const auth = await authorizeRepository(request, 'project:manage')
      if (!auth.ok)
        return response.json({ error: auth.error }, auth.status)
      const id = positiveId(request.getParam('project'))
      await changeProject(Number(auth.context.repository.id), id, async (tx, project) => {
        if (positiveId(request.get('revision')) !== Number(project.revision))
          throw new ForgeError('This project changed. Reload before saving.', 409)
        const state = String(request.get('state') ?? project.state)
        if (!['open', 'closed'].includes(state))
          throw new ForgeError('Project state must be open or closed')
        const description = String(request.get('description') ?? project.description)
        if (Buffer.byteLength(description) > 60_000)
          throw new ForgeError('Project descriptions allow 60 KB of text')
        await tx.updateTable('projects').set({ title: titleField(request.get('title') ?? project.title), description, state }).where('id', '=', id).execute()
      }, true)
      return forgeResult(request, { id, updated: true }, projectUrl(request, id))
    })
  },
})
