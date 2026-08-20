import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { authorizeRepository } from '../Repo/authorize'
import { staleTickedFiles } from './incremental'
import { pullRequestFor, viewedFiles } from './reviewState'

/**
 * Which of this reviewer's ticks no longer describe the file they ticked.
 *
 * A tick says "I have read this file", and it is recorded with the head it was
 * read at. The obvious way to keep it honest - the head moved, so unmark
 * everything - is wrong, because the head is one sha for the *whole* pull
 * request: a push touching one file would clear the ticks on all two hundred,
 * and a reviewer who watched that happen would learn to ignore it. `head_sha`
 * has been stored and deliberately unused since it was added, for that reason.
 *
 * So the question is asked per file, and it is the one the incremental diff
 * already answers: each head fingerprinted against its own merge base, compared
 * path by path. A file whose proposal is byte for byte what they read keeps its
 * tick through any number of pushes and rebases underneath it.
 *
 * Separate from the review-state endpoint on purpose. That one is fetched on
 * every page load and answers from the database alone; this one streams two or
 * more diffs of the pull request, so it is asked for once, after the page is
 * usable, exactly like "since I last looked" beside it.
 */
export default new Action({
  name: 'StaleTicks',
  description: 'The files this reviewer ticked that have changed since they read them',
  method: 'GET',

  // Declared so the document can publish them: every key is one the handler
  // reads. **Enforced, not descriptive**: the framework checks these before the
  // handler runs and answers 422 itself, so a named type here is a promise that
  // the endpoint refuses every other spelling of the value. A field the handler
  // coerces takes `coerced` from `app/Actions/inputs.ts` instead.
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
  },

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    const owner = String(request.get('owner') ?? '').trim().toLowerCase()

    const pullRequest = await pullRequestFor(repository.id, Number(request.get('number')))
    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    // Nobody signed in has ticked anything. Not an error, and the interface
    // shows nothing rather than an empty explanation.
    if (!user)
      return response.json({ stale: [], unverifiable: [] })

    const ticked = await viewedFiles(pullRequest.id, user.id)
    if (ticked.length === 0)
      return response.json({ stale: [], unverifiable: [] })

    const row = await db
      .selectFrom('pull_requests')
      .select(['base_sha'])
      .where('id', '=', pullRequest.id)
      .executeTakeFirst()

    const result = await staleTickedFiles({
      owner,
      repository: repository.name,
      base: String(row?.base_sha ?? ''),
      head: pullRequest.head_sha,
      ticked: ticked.map(file => ({ path: file.path, headSha: file.head_sha })),
    })

    // The head itself could not be read, which is the only case with no answer
    // rather than an empty one. Reported rather than rendered as "all fine".
    if (!result)
      return response.json({ unreadable: true, stale: [], unverifiable: [] })

    return response.json({ head: pullRequest.head_sha, ...result })
  },
})
