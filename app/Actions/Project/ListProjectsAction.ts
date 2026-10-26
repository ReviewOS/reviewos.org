import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { authorizeRepository } from '../Repo/authorize'
import { projectList } from './projects'
import { pageOffset } from '../Support/forge'

export default new Action({
  name: 'ListProjects', method: 'GET', description: 'List repository projects',
  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'project:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)
    const offset = pageOffset(request.get('offset'))
    const projects = await projectList(Number(auth.context.repository.id), offset)
    return response.json({ projects: projects.slice(0, 100), next_offset: projects.length > 100 ? offset + 100 : null })
  },
})
