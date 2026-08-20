import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
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

  // Declared so the document can publish them: every key is one the handler
  // reads. **Enforced, not descriptive**: the framework checks these before the
  // handler runs and answers 422 itself, so a named type here is a promise that
  // the endpoint refuses every other spelling of the value. A field the handler
  // coerces takes `coerced` from `app/Actions/inputs.ts` instead.
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    ref: { rule: schema.string() },
  },

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
