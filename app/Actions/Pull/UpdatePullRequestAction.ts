import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { recordCrossReferences } from '../Issue/crossReferences'
import { syncIssueRow } from './issueRow'
import { isSafeRef, runGit } from '../Git/git'
import { repositoryPath } from '../Git/storage'
import { authorizeRepository } from '../Repo/authorize'
import { editPullRequest, mayEdit } from './state'

/**
 * Edit a pull request's title, body, or base branch.
 *
 * Retargeting the base is the part that does real work. The base branch decides
 * the merge base, which decides the diff, which decides what every review thread
 * is anchored against, so moving it recomputes `base_sha` and re-derives whether
 * this pull request is stacked on another one. Recording a new base without the
 * new merge base would leave the review showing a diff that no longer matches
 * what would be merged.
 */
export default new Action({
  name: 'UpdatePullRequest',
  description: 'Edit a pull request title, body, or base branch',
  method: 'PUT',

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

    const { repository, user, can } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const number = Number(request.get('number'))
    const pullRequest = await db
      .selectFrom('pull_requests')
      .select(['id', 'state', 'author_id', 'head_branch', 'head_sha', 'base_branch'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    const isAuthor = Number(pullRequest.author_id) === user.id
    if (!mayEdit({ isAuthor, canEditAny: can('pull:edit-any') }))
      return response.json({ error: 'Forbidden' }, 403)

    const result = editPullRequest(
      {
        state: pullRequest.state as 'open' | 'closed' | 'merged',
        headBranch: String(pullRequest.head_branch),
      },
      {
        title: field(request, 'title'),
        body: field(request, 'body'),
        base: field(request, 'base'),
      },
    )

    if (!result.ok)
      return response.json({ error: result.error }, result.status)

    const changes: Record<string, unknown> = { ...result.changes }
    const base = result.changes.base_branch

    if (base !== undefined && base !== String(pullRequest.base_branch)) {
      if (!isSafeRef(base))
        return response.json({ error: 'That branch name cannot be used' }, 422)

      const resolved = repositoryPath(String(request.get('owner')), repository.name)
      if (!resolved.ok)
        return response.json({ error: 'Repository not found' }, 404)

      const baseSha = await revision(resolved.path!, base)
      if (!baseSha)
        return response.json({ error: `There is no branch named ${base}` }, 422)

      changes.base_sha = baseSha

      // The stack is derived from branch topology rather than declared, so
      // retargeting can join a stack, leave one, or move within it. Recomputing
      // here keeps that the single source of the relationship.
      const parent = await db
        .selectFrom('pull_requests')
        .select(['id'])
        .where('repository_id', '=', repository.id)
        .where('head_branch', '=', base)
        .where('state', '=', 'open')
        .executeTakeFirst()

      const parentId = parent ? Number(parent.id) : null

      // A pull request cannot be stacked on itself, which is reachable by
      // retargeting onto a branch that is its own head elsewhere in the table.
      changes.stack_parent_id = parentId === Number(pullRequest.id) ? null : parentId
    }

    if (Object.keys(changes).length > 0) {
      await db
        .updateTable('pull_requests')
        .set(changes)
        .where('id', '=', Number(pullRequest.id))
        .execute()

      // The shadow row carries title and body, so an edit that changes either
      // has to reach it. `syncIssueRow` writes only the keys it is given, so
      // retargeting a base leaves the title alone rather than blanking it.
      if (changes.title !== undefined || changes.body !== undefined) {
        await syncIssueRow({
          repositoryId: Number(repository.id),
          number,
          ...(changes.title === undefined ? {} : { title: String(changes.title) }),
          ...(changes.body === undefined ? {} : { body: changes.body === null ? null : String(changes.body) }),
          state: String(pullRequest.state ?? 'open'),
        })
      }
    }

    /*
     * A reference edited into the body counts, exactly as it does on an issue.
     *
     * Only when `body` was supplied: omitting it leaves the body alone, so
     * scanning the old text again would be work with no possible result.
     * Already-recorded references are not written twice, so editing a body for
     * any other reason records nothing. See `UpdateIssueAction`, which this
     * mirrors.
     */
    const editedBody = field(request, 'body')

    if (editedBody !== undefined) {
      await recordCrossReferences(
        { subject: { type: 'pull_request', id: Number(pullRequest.id) }, number, repositoryId: repository.id },
        user.id,
        String(editedBody),
      )
    }

    return response.json({
      number,
      title: changes.title ?? undefined,
      base: changes.base_branch ?? String(pullRequest.base_branch),
      stacked_on: changes.stack_parent_id ?? undefined,
      updated: Object.keys(changes),
    })
  },
})

/**
 * A field the caller supplied, or undefined when they did not.
 *
 * Absent and empty mean different things here: omitting `body` leaves it alone,
 * sending an empty one clears it. Coercing everything with `String()` up front
 * would erase that distinction.
 */
function field(request: any, name: string): string | undefined {
  const value = request.get(name)

  return value === undefined || value === null ? undefined : String(value)
}

/** The commit a branch points at, or null when the branch does not exist. */
async function revision(path: string, ref: string): Promise<string | null> {
  const result = await runGit(path, ['rev-parse', '--verify', `refs/heads/${ref}`])

  return result.ok ? result.stdout.trim() : null
}
