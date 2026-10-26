import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { response } from '@stacksjs/router'
import { coerced } from '../inputs'
import { authorizeRepository } from '../Repo/authorize'
import { forgeResponse, forgeResult, ForgeError, positiveId } from '../Support/forge'
import { dbTimestamp } from '../Support/sql'
import { changeProject, projectColumn, projectUrl } from './projects'

export default new Action({
  name: 'MoveProjectItem', method: 'POST', description: 'Move or reorder a project card with a revision check',
  validations: { column_id: { rule: coerced }, before_item_id: { rule: coerced }, revision: { rule: coerced } },
  async handle(request: RequestInstance) {
    return forgeResponse(async () => {
      const auth = await authorizeRepository(request, 'project:move')
      if (!auth.ok)
        return response.json({ error: auth.error }, auth.status)
      const projectId = positiveId(request.getParam('project'))
      const itemId = positiveId(request.getParam('item'))
      const columnId = positiveId(request.get('column_id'))
      await changeProject(Number(auth.context.repository.id), projectId, async (tx) => {
        await projectColumn(tx, projectId, columnId)
        const item = await tx.selectFrom('project_items').selectAll().where('project_id', '=', projectId).where('id', '=', itemId).executeTakeFirst()
        if (!item)
          throw new ForgeError('No such project card', 404)
        if (positiveId(request.get('revision')) !== Number(item.revision))
          throw new ForgeError('This card moved while you were editing. Reload the board.', 409)
        let position: number
        let insertBefore = false
        if (request.get('before_item_id')) {
          const destination = await tx.selectFrom('project_items').select(['position']).where('project_column_id', '=', columnId).where('id', '=', positiveId(request.get('before_item_id'))).where('id', '!=', itemId).executeTakeFirst()
          if (!destination)
            throw new ForgeError('The destination card is not in that column')
          position = Number(destination.position)
          insertBefore = true
        }
        else if (request.get('placement') === 'first') {
          position = 0
          insertBefore = true
        }
        else {
          const last = await tx.selectFrom('project_items').select(['position']).where('project_column_id', '=', columnId).where('id', '!=', itemId).orderBy('position', 'desc').executeTakeFirst()
          position = Number(last?.position ?? -1) + 1
        }
        if (insertBefore) {
          // The builder's arithmetic fragment shifts the indexed range in one
          // update, avoiding one round trip per card on a large board.
          await tx.updateTable('project_items').set({ position: db.raw('position + 1') }).where('project_column_id', '=', columnId).where('id', '!=', itemId).where('position', '>=', position).execute()
        }
        await tx.updateTable('project_items').set({ project_column_id: columnId, position, revision: Number(item.revision) + 1, updated_at: dbTimestamp() }).where('id', '=', itemId).execute()
      })
      return forgeResult(request, { id: itemId, column_id: columnId }, projectUrl(request, projectId))
    })
  },
})
