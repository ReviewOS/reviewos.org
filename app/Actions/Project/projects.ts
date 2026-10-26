import { db } from '@stacksjs/database'
import { transaction } from '@stacksjs/orm'
import { ForgeError } from '../Support/forge'
import { dbTimestamp } from '../Support/sql'

export async function projectList(repositoryId: number, offset = 0): Promise<any[]> {
  return db.selectFrom('projects').selectAll().where('repository_id', '=', repositoryId).orderBy('updated_at', 'desc').orderBy('id', 'desc').offset(offset).limit(101).execute()
}

export const PROJECT_PAGE_SIZE = 200

export async function projectBoard(repositoryId: number, id: number, search = '', state = '', offset = 0): Promise<any> {
  const project = await db.selectFrom('projects').selectAll().where('repository_id', '=', repositoryId).where('id', '=', id).executeTakeFirst()
  if (!project)
    throw new ForgeError('No such project', 404)
  const columns = await db.selectFrom('project_columns').selectAll().where('project_id', '=', id).orderBy('position', 'asc').orderBy('id', 'asc').execute()
  let query = db.selectFrom('project_items').innerJoin('issues', 'issues.id', '=', 'project_items.issue_id')
    .innerJoin('project_columns', 'project_columns.id', '=', 'project_items.project_column_id')
    .select(['project_items.id', 'project_items.project_column_id', 'project_items.issue_id', 'project_items.position', 'project_items.revision', 'issues.number', 'issues.title', 'issues.state', 'issues.is_pull_request', 'issues.milestone_id'])
    .where('project_items.project_id', '=', id).where('issues.repository_id', '=', repositoryId)
  if (state === 'open' || state === 'closed')
    query = query.where('issues.state', '=', state)
  const needle = search.trim()
  if (/^#?\d+$/.test(needle))
    query = query.where('issues.number', '=', Number(needle.replace('#', '')))
  else if (needle)
    query = query.whereLike('issues.title', `%${needle}%`, false)
  const cards = await query.orderBy('project_columns.position', 'asc').orderBy('project_columns.id', 'asc').orderBy('project_items.position', 'asc').orderBy('project_items.id', 'asc').offset(offset).limit(PROJECT_PAGE_SIZE + 1).execute()
  const visible = cards.slice(0, PROJECT_PAGE_SIZE)
  return { project, offset, next_offset: cards.length > PROJECT_PAGE_SIZE ? offset + PROJECT_PAGE_SIZE : null, page_size: PROJECT_PAGE_SIZE, columns: columns.map(column => ({ ...column, cards: visible.filter(card => Number(card.project_column_id) === Number(column.id)) })) }
}

/** All board writers take the same root lock, including column deletion. */
export async function changeProject<T>(repositoryId: number, projectId: number, work: (tx: any, project: any) => Promise<T>, allowClosed = false): Promise<T> {
  return transaction(async (tx) => {
    const project = await tx.selectFrom('projects').selectAll().where('id', '=', projectId).where('repository_id', '=', repositoryId).lockForUpdate().executeTakeFirst()
    if (!project)
      throw new ForgeError('No such project', 404)
    if (!allowClosed && project.state === 'closed')
      throw new ForgeError('Reopen this project before changing its board', 409)
    const result = await work(tx, project)
    await tx.updateTable('projects').set({ revision: Number(project.revision) + 1, updated_at: dbTimestamp() }).where('id', '=', projectId).execute()
    return result
  })
}

export async function projectColumn(tx: any, projectId: number, columnId: number): Promise<any> {
  const column = await tx.selectFrom('project_columns').selectAll().where('project_id', '=', projectId).where('id', '=', columnId).executeTakeFirst()
  if (!column)
    throw new ForgeError('No such project column', 404)
  return column
}

export function projectUrl(request: RequestInstance, projectId?: number): string {
  return `/${request.getParam('owner')}/${request.getParam('repository')}/projects${projectId ? `/${projectId}` : ''}`
}
