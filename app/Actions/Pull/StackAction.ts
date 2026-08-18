import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { apiError } from '../../Api/errors'
import { conditional, etagFrom } from '../../Api/etag'
import { authorizeRepository } from '../Repo/authorize'
import { buildStack, orphanMessage, orphanReason, positionIn, stackSummary } from './stack'

/**
 * The stack a pull request belongs to, bottom first.
 *
 * The second endpoint the CLI needed and did not have. A stack was visible only
 * as a rendered navigation strip, so `reviewos stack` would have had to fetch
 * every pull request in the repository and rebuild the chain - which means a
 * second implementation of the ordering, and a second implementation of the
 * ordering is a second answer to "what lands first".
 *
 * `buildStack` is the same function the interface uses. That is the whole point
 * of the endpoint existing rather than the client deriving it.
 */
export default new Action({
  name: 'Stack',
  description: 'The stack a pull request belongs to, in merge order',
  method: 'GET',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
  },

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context

    const number = Number(request.get('number'))
    if (!Number.isInteger(number) || number <= 0) {
      return apiError('invalid_field', 'A pull request number is required', {
        field: 'number',
        fix: 'Pass ?number= with the pull request number.',
      })
    }

    /*
     * Every pull request in the repository, because a stack is a chain and the
     * chain is only knowable from the whole set: a member three above this one
     * is reachable only by following `stack_parent_id` up through rows this
     * query has not seen yet.
     *
     * Repositories with thousands of pull requests will want this narrowed. The
     * honest version of that is a recursive query, not a `LIMIT`, and it is not
     * worth writing before there is a repository that needs it.
     */
    const rows = await db
      .selectFrom('pull_requests')
      .select(['id', 'number', 'title', 'state', 'head_branch', 'base_branch', 'stack_parent_id', 'draft', 'updated_at'])
      .where('repository_id', '=', repository.id)
      .execute()

    const members = rows.map(row => ({
      id: Number(row.id),
      number: Number(row.number),
      title: String(row.title),
      state: String(row.state) as 'open' | 'closed' | 'merged',
      headBranch: String(row.head_branch),
      baseBranch: String(row.base_branch),
      stackParentId: row.stack_parent_id === null || row.stack_parent_id === undefined ? null : Number(row.stack_parent_id),
      draft: Boolean(row.draft),
    }))

    const target = members.find(member => member.number === number)
    if (!target)
      return apiError('not_found', 'No such pull request')

    const stack = buildStack(members, target.id)

    // From the members' own timestamps: the stack changes when one of them
    // does, and nothing else about the repository can move it.
    const tag = etagFrom([
      'stack',
      repository.id,
      number,
      ...stack.map(member => `${member.id}:${rows.find(row => Number(row.id) === member.id)?.updated_at ?? ''}`),
    ])

    return await conditional(request, tag, async () => {
      const position = positionIn(stack, target.id)

      return response.json({
        // Bottom first, which is merge order. A client rendering it top-down
        // reverses; a client landing it must not.
        stack: stack.map(member => ({
          number: member.number,
          title: member.title,
          state: member.state,
          draft: member.draft,
          head_branch: member.headBranch,
          base_branch: member.baseBranch,
          is_current: member.id === target.id,
          // Said per member rather than left to the reader to infer from the
          // branches: an orphaned member is the one thing about a stack that is
          // both easy to miss and expensive to miss.
          orphaned: orphanMessage(orphanReason(member, members)),
        })),
        position: position.position,
        total: position.total,
        // The same sentence the interface shows, from the same function, so the
        // CLI and the page cannot describe one stack two ways.
        summary: stackSummary(stack),
      })
    })
  },
})
