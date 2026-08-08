import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { apiError } from '../../Api/errors'
import { conditional, etagFrom } from '../../Api/etag'
import { pick, readFields, withRequired } from '../../Api/fields'
import { authorizeRepository } from '../Repo/authorize'

/**
 * One pull request, as data.
 *
 * The other half of the parity gap the review queue exposed: the pull request
 * page reads all of this and no endpoint returned it, so an agent that found
 * something in its queue could not then read the thing it found.
 *
 * **Deliberately does not include the diff.** It is usually the larger half by
 * an order of magnitude, and the questions this answers - who wrote it, what is
 * it called, is it mergeable, has anybody approved - are the ones asked before
 * deciding whether to fetch it. `/diff/structured` is one call away for a caller
 * that wants it, and bundling it would make every "is this still open?" cost a
 * git process.
 */
export default new Action({
  name: 'ShowPullRequest',
  description: 'Read one pull request',
  method: 'GET',

  /*
   * Declared so the OpenAPI document, and therefore the generated client, know
   * what this endpoint reads. Without a declaration the document says the
   * endpoint takes nothing, and a client generated from it cannot call it.
   *
   * **Deliberately none of them required.** The framework validates a declared
   * block before the action runs and answers a failure in its own shape, which
   * is not phase 12's error envelope - so requiring `number` here would replace
   * `invalid_field` plus the `fix` sentence below with a generic 422. The
   * declaration describes the shape; the action keeps the refusals, and for
   * input the action would have accepted the check is a no-op.
   */
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
    fields: { rule: schema.string() },
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

    const row: any = await db
      .selectFrom('pull_requests')
      .selectAll()
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!row)
      return apiError('not_found', 'No such pull request')

    /*
     * `updated_at` and the head sha together.
     *
     * The row's timestamp alone misses a force push that rewrote the branch
     * without touching the pull request, and the sha alone misses a retitle.
     * Both are on the row that was just read, so the tag costs nothing.
     */
    const tag = etagFrom(['pull', row.id, row.updated_at, row.head_sha, row.state])

    return await conditional(request, tag, async () => {
      const fields = withRequired(readFields(request.get('fields')), ['number'])

      const [author, reviews] = await Promise.all([
        db.selectFrom('users').select(['id', 'handle', 'name']).where('id', '=', row.author_id).executeTakeFirst(),
        db
          .selectFrom('pull_request_reviews')
          .select(['reviewer_id', 'state', 'commit_sha', 'submitted_at'])
          .where('pull_request_id', '=', row.id)
          .execute(),
      ])

      const full = {
        number: Number(row.number),
        title: String(row.title ?? ''),
        body: String(row.body ?? ''),
        state: String(row.state ?? ''),
        draft: Boolean(row.draft),
        author: author ? { handle: String((author as any).handle), name: String((author as any).name ?? '') } : null,
        base_branch: String(row.base_branch ?? ''),
        head_branch: String(row.head_branch ?? ''),
        base_sha: String(row.base_sha ?? ''),
        head_sha: String(row.head_sha ?? ''),
        additions: Number(row.additions ?? 0),
        deletions: Number(row.deletions ?? 0),
        changed_files: Number(row.changed_files ?? 0),
        /*
         * The verdicts, not a count.
         *
         * "2 approvals" cannot answer the question an agent actually has, which
         * is whether *its* review is among them and whether any of them were
         * written against an older head.
         */
        reviews: (reviews as any[]).map(review => ({
          state: String(review.state),
          commit_sha: String(review.commit_sha ?? ''),
          submitted_at: review.submitted_at ? String(review.submitted_at) : null,
          // Stale when the head has moved since. Said here rather than left to
          // the caller to work out by comparing shas, which is the comparison
          // people forget.
          stale: String(review.commit_sha ?? '') !== String(row.head_sha ?? ''),
        })),
        created_at: row.created_at ? String(row.created_at) : null,
        updated_at: row.updated_at ? String(row.updated_at) : null,
      }

      return response.json(pick(full, fields))
    })
  },
})
