import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { coerced } from '../inputs'
import { authorizeRepository } from '../Repo/authorize'
import { forgeResponse, forgeResult, ForgeError, positiveId } from '../Support/forge'
import { dbTimestamp } from '../Support/sql'
import { changeProject, projectColumn, projectUrl } from './projects'

export default new Action({
  name: 'AddProjectItem', method: 'POST', description: 'Add an issue or pull request to a project board',
  validations: { number: { rule: coerced }, column_id: { rule: coerced } },
  async handle(request: RequestInstance) {
    return forgeResponse(async () => {
      const auth = await authorizeRepository(request, 'project:move')
      if (!auth.ok)
        return response.json({ error: auth.error }, auth.status)
      const repositoryId = Number(auth.context.repository.id)
      const projectId = positiveId(request.getParam('project'))
      const result = await changeProject(repositoryId, projectId, async (tx) => {
        const columnId = positiveId(request.get('column_id'))
        await projectColumn(tx, projectId, columnId)
        const issue = await tx.selectFrom('issues').select(['id', 'number']).where('repository_id', '=', repositoryId).where('number', '=', positiveId(request.get('number'))).executeTakeFirst()
        if (!issue)
          throw new ForgeError('No such issue or pull request in this repository', 404)
        const existing = await tx.selectFrom('project_items').select(['id']).where('project_id', '=', projectId).where('issue_id', '=', Number(issue.id)).executeTakeFirst()
        if (existing)
          throw new ForgeError('That issue is already on this board', 409)
        const last = await tx.selectFrom('project_items').select(['position']).where('project_column_id', '=', columnId).orderBy('position', 'desc').executeTakeFirst()
        const row = await tx.insertInto('project_items').values({ repository_id: repositoryId, project_id: projectId, project_column_id: columnId, issue_id: Number(issue.id), position: Number(last?.position ?? -1) + 1, revision: 1, created_at: dbTimestamp(), updated_at: dbTimestamp() }).returning(['id']).executeTakeFirst()
        return { id: Number(row?.id), number: Number(issue.number) }
      })
      return forgeResult(request, result, projectUrl(request, projectId), 201)
    })
  },
})
