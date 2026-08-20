import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { diskPathFor } from '../Git/access'
import { mergeBase } from '../Git/git'
import { authorizeRepository } from '../Repo/authorize'
import { blameLineAt, pullRequestForCommit } from './blame'
import { pullRequestFor } from './reviewState'

/**
 * Why one context line is here: the commit, and when the records can say,
 * the pull request that landed it.
 *
 * One line, on demand - blame walks history per line and a file of it on
 * render is the slowest thing a review screen can do. The line is blamed at
 * the merge base, because that is what the diff's old-side numbers index.
 */
export default new Action({
  name: 'BlameLine',
  description: 'Why one context line of a diff is here',
  method: 'GET',

  // Declared so the document can publish them: every key is one the handler
  // reads, and none is required, because this describes the inputs rather than
  // changing what the endpoint accepts.
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
    line: { rule: schema.number() },
    path: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const owner = String(request.get('owner') ?? '').trim().toLowerCase()

    const pullRequest = await pullRequestFor(repository.id, Number(request.get('number')))
    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    const diskPath = diskPathFor(owner, repository.name)
    if (!diskPath)
      return response.json({ error: 'Repository not found' }, 404)

    const path = String(request.get('path') ?? '').trim()
    const line = Number(request.get('line'))

    if (!path || !Number.isInteger(line) || line <= 0)
      return response.json({ error: 'A path and a line are required' }, 422)

    const row = await db
      .selectFrom('pull_requests')
      .select(['base_sha', 'head_sha', 'base_branch'])
      .where('id', '=', Number(pullRequest.id))
      .executeTakeFirst()

    const base = await mergeBase(diskPath, String(row?.base_sha ?? ''), String(row?.head_sha ?? ''))
    if (!base)
      return response.json({ error: 'The two histories share no base to blame against' }, 422)

    const blamed = await blameLineAt(diskPath, base, path, line)
    if (!blamed)
      return response.json({ error: 'That line cannot be blamed' }, 422)

    const landedBy = await pullRequestForCommit(
      Number(repository.id),
      diskPath,
      blamed.sha,
      String(row?.base_branch ?? 'main'),
    )

    return response.json({
      sha: blamed.sha,
      author: blamed.authorName,
      authoredAt: blamed.authoredAt,
      summary: blamed.summary,
      // Null when the records cannot say, which is true rather than a guess:
      // a rebase-merged middle commit belongs to no recorded pull request.
      pullRequest: landedBy,
    })
  },
})
