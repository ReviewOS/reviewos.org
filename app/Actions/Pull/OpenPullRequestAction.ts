import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { refusal, spendFor } from '../../Api/token-limits'
import { repositoryPath } from '../Git/storage'
import { authorizeRepository } from '../Repo/authorize'
import { openPullRequest } from './open'

/**
 * Open a pull request.
 *
 * The head and base are resolved through git at open time so the pull request
 * records the commits it was opened against. Without that, a review has nothing
 * stable to anchor to and a rebase silently changes what was approved.
 *
 * A pull request whose base is another open pull request's branch is recorded
 * as stacked, which is what lets the stack retarget itself when the bottom of
 * it merges.
 *
 * The work itself is [`open.ts`](./open.ts), shared with the repair agent. What
 * stays here is what is about a *request*: who is asking, whether the arguments
 * are the declared shape, and the token's hourly budget.
 */
export default new Action({
  name: 'OpenPullRequest',
  description: 'Open a pull request between two branches',
  method: 'POST',

  /*
   * Declared here so the reference lists them and the validator enforces them
   * from the same object. Read against the handler rather than the field name:
   * a declared rule is enforced, so a wrong one turns an ordinary request into
   * a 422 - which is how `assignees: string` broke assigning somebody.
   */
  validations: {
    owner: { rule: schema.string().required() },
    repo: { rule: schema.string() },
    repository: { rule: schema.string() },
    title: { rule: schema.string().required() },
    head: { rule: schema.string().required() },
    base: { rule: schema.string() },
    body: { rule: schema.string() },
    draft: { rule: schema.boolean() },
  },

  responses: {
    201: { description: 'The pull request, with the number it was given.' },
    401: { description: 'Unauthenticated.' },
    409: { description: 'An open pull request from this head to this base already exists. Two of them would be two conversations about one change.' },
    422: { description: 'A title and a head branch are required, the head must exist, and it cannot be the base.' },
    404: { description: 'No such repository or pull request, or none this caller may see. A private repository answers this rather than 403, because a 403 confirms it exists.' },
  },

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'pull:open')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const owner = String(request.get('owner') ?? '').trim()
    const resolved = repositoryPath(owner, repository.name)
    if (!resolved.ok)
      return response.json({ error: 'Repository not found' }, 404)

    /*
     * The token's hourly budget, spent before anything is created.
     *
     * Before the pull request number is allocated, because that increments the
     * repository's counter and a refusal after it would burn a number on a
     * request that never happened - leaving a gap somebody has to explain.
     */
    const budget = await spendFor(request, 'pull_requests')
    if (!budget.verdict.allowed)
      return refusal('pull_requests', budget.limit, budget.verdict)

    const opened = await openPullRequest({
      diskPath: resolved.path!,
      repositoryId: repository.id,
      owner,
      repository: repository.name,
      title: String(request.get('title') ?? ''),
      body: String(request.get('body') ?? ''),
      head: String(request.get('head') ?? ''),
      base: String(request.get('base') ?? repository.default_branch),
      authorId: user.id,
      authorHandle: user.handle,
      draft: Boolean(request.get('draft')),
    })

    if (!opened.ok)
      return response.json({ error: opened.error }, opened.status)

    return response.json({
      id: opened.id,
      number: opened.number,
      title: opened.title,
      head: opened.head,
      base: opened.base,
      stacked_on: opened.stackedOn,
      state: 'open',
      review_requests: opened.reviewRequests,
    }, 201)
  },
})
