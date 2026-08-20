import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { browseContext } from './context'
import { compareRefs } from './load'

/**
 * Two refs, and what stands between them.
 *
 * This is the shape a pull request is opened from, so it answers the same
 * questions the pull request page asks: which commits, which files, how far
 * ahead and how far behind.
 *
 * Diffed from the merge base rather than from the base tip. Diffing against the
 * tip mixes in every change made on the base since the branch left it, which
 * shows a reviewer other people's commits and asks them to approve.
 */
export default new Action({
  name: 'BrowseCompare',
  description: 'Compare two refs',
  method: 'GET',

  // Declared so the document can publish them: every key is one the handler
  // reads, and none is required, because this describes the inputs rather than
  // changing what the endpoint accepts.
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    base: { rule: schema.string() },
    head: { rule: schema.string() },
    ref: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const browse = await browseContext(request)
    if (!browse.ok)
      return response.json({ error: browse.error }, browse.status)

    const { diskPath, repository } = browse.context
    const base = String(request.get('base') ?? '').trim() || String(repository.default_branch || 'HEAD')
    const head = String(request.get('head') ?? '').trim()

    if (!head)
      return response.json({ error: 'No head ref given' }, 422)

    const comparison = await compareRefs(diskPath, base, head)

    if (!comparison.ok)
      return response.json({ error: comparison.error ?? 'Could not compare those refs' }, 404)

    return response.json(comparison)
  },
})
