import { Action } from '@stacksjs/actions'
import { transaction } from '@stacksjs/orm'
import { response } from '@stacksjs/router'
import { schema } from '@stacksjs/validation'
import { authorizeRepository } from '../Repo/authorize'
import { forgeResponse, forgeResult, titleField, ForgeError } from '../Support/forge'
import { dbTimestamp } from '../Support/sql'
import { projectUrl } from './projects'

export default new Action({
  name: 'CreateProject', method: 'POST', description: 'Create a native issue project with a configurable board',
  validations: { title: { rule: schema.string().required().max(160) }, description: { rule: schema.string() } },
  async handle(request: RequestInstance) {
    return forgeResponse(async () => {
      const auth = await authorizeRepository(request, 'project:manage')
      if (!auth.ok)
        return response.json({ error: auth.error }, auth.status)
      const title = titleField(request.get('title'))
      const description = String(request.get('description') ?? '')
      if (Buffer.byteLength(description) > 60_000)
        throw new ForgeError('Project descriptions allow 60 KB of text')
      const id = await transaction(async (tx) => {
        const now = dbTimestamp()
        const row = await tx.insertInto('projects').values({ repository_id: auth.context.repository.id, title, description, state: 'open', revision: 1, created_at: now, updated_at: now }).returning(['id']).executeTakeFirst()
        const projectId = Number(row?.id)
        await tx.insertInto('project_columns').values(['Backlog', 'In progress', 'Done'].map((columnTitle, position) => ({ repository_id: auth.context.repository.id, project_id: projectId, title: columnTitle, position, created_at: now, updated_at: now }))).execute()
        return projectId
      })
      return forgeResult(request, { id, title, description, state: 'open' }, projectUrl(request, id), 201)
    })
  },
})
