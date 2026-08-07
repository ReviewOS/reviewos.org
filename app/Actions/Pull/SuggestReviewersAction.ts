import { Action } from '@stacksjs/actions'
import { diskPathFor } from '../Git/access'
import { runGit } from '../Git/git'
import { authorizeRepository } from '../Repo/authorize'
import { pullRequestFor } from './reviewState'
import { contributionsFor, resolveContributors, reviewLoad, suggestReviewers } from './suggest'

/**
 * Who might usefully look at this pull request.
 *
 * A suggestion, never a request. Asking somebody is a person's decision: a
 * forge that requested reviews automatically from a heuristic would fill
 * everybody's queue with guesses, and a queue full of guesses is a queue people
 * stop reading. `CODEOWNERS` requests automatically because a file in the
 * repository said to; this is the forge having an opinion, and an opinion is
 * offered rather than acted on.
 *
 * `pull:review` rather than `repository:read`. The answer names people and how
 * much work is waiting on them, which is a thing to show somebody who is part
 * of reviewing here rather than to anyone who can read the code.
 */
export default new Action({
  name: 'SuggestReviewers',
  description: 'Who has worked on the files this pull request changes',
  method: 'GET',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'pull:review')
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

    const row = await db
      .selectFrom('pull_requests')
      .select(['base_sha', 'author_id'])
      .where('id', '=', pullRequest.id)
      .executeTakeFirst()

    const baseSha = String(row?.base_sha ?? '')
    const paths = await changedPaths(diskPath, baseSha, pullRequest.head_sha)

    if (paths.length === 0)
      return response.json({ suggestions: [] })

    // History on the base, not the head. The head's recent commits are the ones
    // being reviewed, and counting them would suggest the author of the change
    // as the reviewer of it.
    const raw = await contributionsFor({ diskPath, ref: baseSha, paths })
    const contributions = await resolveContributors(raw)

    if (contributions.length === 0)
      return response.json({ suggestions: [] })

    const [load, exclude] = await Promise.all([
      reviewLoad(contributions.map(one => one.handle)),
      alreadyInvolved(pullRequest.id, Number(row?.author_id ?? 0)),
    ])

    return response.json({
      suggestions: suggestReviewers({
        contributions,
        load,
        exclude,
        now: Date.now(),
      }),
    })
  },
})

/** The paths this pull request changes, three dots. */
async function changedPaths(diskPath: string, baseSha: string, headSha: string): Promise<string[]> {
  if (!baseSha || !headSha)
    return []

  const result = await runGit(diskPath, ['diff', '--name-only', `${baseSha}...${headSha}`])

  return result.ok ? result.stdout.split('\n').map(line => line.trim()).filter(Boolean) : []
}

/**
 * The author, and everybody already asked.
 *
 * Suggesting the author is absurd; suggesting somebody already on the list
 * makes the feature look broken to the person who just added them.
 */
async function alreadyInvolved(pullRequestId: number, authorId: number): Promise<string[]> {
  const rows: any[] = await db
    .selectFrom('pull_request_reviewers')
    .innerJoin('users', 'users.id', '=', 'pull_request_reviewers.reviewer_id')
    .select(['users.handle as handle'])
    .where('pull_request_reviewers.pull_request_id', '=', pullRequestId)
    .execute()

  const handles = rows.map(row => String(row.handle))

  if (authorId) {
    const author = await db
      .selectFrom('users')
      .select(['handle'])
      .where('id', '=', authorId)
      .executeTakeFirst()

    if (author?.handle)
      handles.push(String(author.handle))
  }

  return handles
}
