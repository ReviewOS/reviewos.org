import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { diskPathFor } from '../Git/access'
import { authorizeRepository } from '../Repo/authorize'
import { branchExists, mayRestoreHeadBranch, restoreHeadBranch } from './restore'

/**
 * Put a merged pull request's head branch back.
 *
 * Delete-on-merge is a repository setting, and the person who wants the branch
 * back is usually the person who just watched it go: a follow-up they meant to
 * stack, a deploy job that pulls the branch by name. The sha is on the pull
 * request, so this is a button and a guarded ref write.
 *
 * `repository:push` because that is what it is - creating a branch - and not a
 * merge-adjacent power: somebody who may not push should not be able to make
 * refs appear either.
 */
export default new Action({
  name: 'RestoreHeadBranch',
  description: 'Restore the head branch a merge deleted',
  method: 'POST',

  // Declared so the document can publish them: every key is one the handler
  // reads, and none is required, because this describes the inputs rather than
  // changing what the endpoint accepts.
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
  },

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'repository:push')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const owner = String(request.get('owner') ?? '').trim().toLowerCase()
    const number = Number(request.get('number'))

    const pullRequest = await db
      .selectFrom('pull_requests')
      .select(['id', 'state', 'head_branch', 'head_sha'])
      .where('repository_id', '=', Number(repository.id))
      .where('number', '=', number)
      .executeTakeFirst()

    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    const diskPath = diskPathFor(owner, repository.name)
    if (!diskPath)
      return response.json({ error: 'Repository not found' }, 404)

    const branch = String(pullRequest.head_branch ?? '')
    const sha = String(pullRequest.head_sha ?? '')

    const may = mayRestoreHeadBranch({
      state: String(pullRequest.state),
      headBranch: branch,
      headSha: sha,
      exists: await branchExists(diskPath, branch),
    })

    if (!may.ok)
      return response.json({ error: may.error }, may.status)

    const restored = await restoreHeadBranch(diskPath, branch, sha)
    if (!restored.ok)
      return response.json({ error: restored.error }, 409)

    return response.json({ restored: true, branch, sha })
  },
})
