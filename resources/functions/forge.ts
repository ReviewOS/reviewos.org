import { db } from '@stacksjs/database'
import { repositoryForView } from '../../app/Actions/Repo/forView'
import { wikiHistory, wikiHtml, wikiPage, wikiPages, wikiSlug } from '../../app/Actions/Wiki/wiki'
import { projectBoard, projectList } from '../../app/Actions/Project/projects'
import { packagePath, pantryJson, publicMetadata, registryConfigured, registryPackages, requirePackage } from '../../app/Actions/Registry/pantry'
import { ForgeError, pageOffset, positiveId } from '../../app/Actions/Support/forge'

async function toolContext(owner: string, repository: string, cookies?: Record<string, string>): Promise<any> {
  const access = await repositoryForView(owner, repository, cookies)
  return {
    owner, repository, base: `/${owner}/${repository}`, api: `/api/repos/${owner}/${repository}`, access,
    exists: Boolean(access), status: access ? 200 : 404,
    mayWriteWiki: Boolean(access?.can('wiki:write') && !access.repository.is_archived),
    mayManageProject: Boolean(access?.can('project:manage') && !access.repository.is_archived),
    mayMove: Boolean(access?.can('project:move') && !access.repository.is_archived),
    mayPublish: Boolean(access?.can('package:publish') && !access.repository.is_archived),
  }
}

export async function wikiForView(owner: string, repository: string, cookies?: Record<string, string>, slug?: string, query: Record<string, string> = {}): Promise<any> {
  const context = await toolContext(owner, repository, cookies)
  const data = { ...context, offset: pageOffset(query.offset), nextOffset: null, pages: [], page: null, selected: null, history: [], html: '', editing: query.edit === '1', creating: query.new === '1', showHistory: query.history === '1' }
  if (!context.exists)
    return data
  const pages = await wikiPages(Number(context.access.repository.id), data.offset)
  data.pages = pages.slice(0, 100)
  data.nextOffset = pages.length > 100 ? data.offset + 100 : null
  if (!slug)
    return data
  try {
    data.page = await wikiPage(Number(context.access.repository.id), wikiSlug(slug))
    if (!data.page || (data.page.is_deleted && !data.showHistory && !data.editing))
      return { ...data, status: 404 }
    data.selected = query.revision
      ? await db.selectFrom('wiki_revisions').selectAll().where('wiki_page_id', '=', Number(data.page.id)).where('revision', '=', positiveId(query.revision)).executeTakeFirst()
      : data.page
    if (!data.selected)
      return { ...data, status: 404 }
    data.history = await wikiHistory(Number(data.page.id))
    data.html = wikiHtml(String(data.selected.body ?? ''), `${context.base}/wiki`)
    return data
  }
  catch (error) {
    if (error instanceof ForgeError)
      return { ...data, status: 404 }
    throw error
  }
}

export async function projectsForView(owner: string, repository: string, cookies?: Record<string, string>, id?: string, query: Record<string, string> = {}): Promise<any> {
  const context = await toolContext(owner, repository, cookies)
  const data = { ...context, offset: pageOffset(query.offset), nextOffset: null, projects: [], board: null, search: query.q ?? '', state: query.state ?? '', listView: query.view === 'list' }
  if (!context.exists)
    return data
  if (!id) {
    const projects = await projectList(Number(context.access.repository.id), data.offset)
    return { ...data, projects: projects.slice(0, 100), nextOffset: projects.length > 100 ? data.offset + 100 : null }
  }
  try {
    data.board = await projectBoard(Number(context.access.repository.id), positiveId(id), data.search, data.state, data.offset)
    data.mayMove = context.mayMove && data.board.project.state === 'open'
    data.mayEditBoard = context.mayManageProject && data.board.project.state === 'open'
    return data
  }
  catch (error) {
    if (error instanceof ForgeError)
      return { ...data, status: 404 }
    throw error
  }
}

export async function packagesForView(owner: string, repository: string, cookies?: Record<string, string>, query: Record<string, string> = {}): Promise<any> {
  const context = await toolContext(owner, repository, cookies)
  const data = { ...context, offset: pageOffset(query.offset), nextOffset: null, configured: registryConfigured(), packages: [], selected: null, versions: [], error: '' }
  if (!context.exists)
    return data
  const packages = await registryPackages(Number(context.access.repository.id), data.offset)
  data.packages = packages.slice(0, 100)
  data.nextOffset = packages.length > 100 ? data.offset + 100 : null
  const name = query.name
  if (!name)
    return data
  try {
    await requirePackage(Number(context.access.repository.id), name)
    data.selected = publicMetadata(await pantryJson(`/packages/${packagePath(name)}${query.version ? `/${encodeURIComponent(query.version)}` : ''}`), `${context.api}/registry`)
    const result = await pantryJson(`/packages/${packagePath(name)}/versions`)
    data.versions = result.versions ?? []
  }
  catch (error) {
    if (error instanceof ForgeError)
      data.error = error.message
    else
      throw error
  }
  return data
}
