import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { schema } from '@stacksjs/validation'
import { coerced } from '../inputs'
import { authorizeRepository } from '../Repo/authorize'
import { forgeResponse, forgeResult, ForgeError, positiveId, titleField } from '../Support/forge'
import { dbTimestamp } from '../Support/sql'
import { changeProject, projectColumn, projectUrl } from './projects'

export default new Action({
  name: 'ManageProjectColumn', method: 'POST', description: 'Create, rename, reorder or remove an empty project column',
  validations: { title: { rule: schema.string() }, operation: { rule: schema.string() }, column_id: { rule: coerced } },
  async handle(request: RequestInstance) {
    return forgeResponse(async () => {
      const auth = await authorizeRepository(request, 'project:manage')
      if (!auth.ok)
        return response.json({ error: auth.error }, auth.status)
      const projectId = positiveId(request.getParam('project'))
      const result = await changeProject(Number(auth.context.repository.id), projectId, async (tx) => {
        const operation = String(request.get('operation') ?? 'create')
        const columns = await tx.selectFrom('project_columns').selectAll().where('project_id', '=', projectId).orderBy('position', 'asc').orderBy('id', 'asc').execute()
        if (operation === 'create') {
          if (columns.length >= 30)
            throw new ForgeError('A board can have up to 30 columns')
          const row = await tx.insertInto('project_columns').values({ repository_id: auth.context.repository.id, project_id: projectId, title: titleField(request.get('title')), position: columns.length, created_at: dbTimestamp(), updated_at: dbTimestamp() }).returning(['id']).executeTakeFirst()
          return { id: Number(row?.id) }
        }
        const columnId = positiveId(request.get('column_id'))
        await projectColumn(tx, projectId, columnId)
        if (operation === 'rename')
          await tx.updateTable('project_columns').set({ title: titleField(request.get('title')), updated_at: dbTimestamp() }).where('id', '=', columnId).execute()
        else if (operation === 'delete') {
          if (columns.length === 1)
            throw new ForgeError('Keep at least one column')
          const card = await tx.selectFrom('project_items').select(['id']).where('project_column_id', '=', columnId).executeTakeFirst()
          if (card)
            throw new ForgeError('Move the cards out before deleting this column', 409)
          await tx.deleteFrom('project_columns').where('id', '=', columnId).execute()
        }
        else if (operation === 'left' || operation === 'right') {
          const index = columns.findIndex((column: any) => Number(column.id) === columnId)
          const other = operation === 'left' ? index - 1 : index + 1
          if (other >= 0 && other < columns.length)
            [columns[index], columns[other]] = [columns[other], columns[index]]
        }
        else
          throw new ForgeError('Unknown column operation')
        const remaining = columns.filter((column: any) => operation !== 'delete' || Number(column.id) !== columnId)
        for (const [position, column] of remaining.entries())
          await tx.updateTable('project_columns').set({ position }).where('id', '=', Number(column.id)).execute()
        return { id: columnId }
      })
      return forgeResult(request, result, projectUrl(request, projectId))
    })
  },
})
