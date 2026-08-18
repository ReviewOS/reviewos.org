import { Action } from '@stacksjs/actions'
import { browseContext } from './context'
import { branchNames } from './load'

/**
 * Every branch, with the default one named.
 *
 * Unpaged. A repository with more branches than fit in one response has a
 * branch-cleanup problem rather than a pagination problem, and a picker that
 * asks for a second page to find `main` is worse than a long list.
 */
export default new Action({
  name: 'BrowseBranches',
  description: 'List a repository branches',
  method: 'GET',

  async handle(request: RequestInstance) {
    const browse = await browseContext(request)
    if (!browse.ok)
      return response.json({ error: browse.error }, browse.status)

    const { diskPath, repository } = browse.context

    return response.json({
      default_branch: repository.default_branch,
      branches: await branchNames(diskPath),
    })
  },
})
