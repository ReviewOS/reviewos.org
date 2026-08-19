import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { decodeCursor, isAfter, pageSize, toPage } from '../../Api/cursor'
import { apiError } from '../../Api/errors'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'

const STATES = ['active', 'disabled', 'removed']

/**
 * The workflows a repository has.
 *
 * The list that was missing from every other question this API can answer: runs
 * could be listed and filtered by workflow, and there was no way to find out
 * which workflows existed except by reading a run and following it back. A
 * client that has to start from a run to learn the shape of a repository's CI
 * is one that cannot show an empty repository anything.
 *
 * The vocabulary is this product's: **repository** and **workflow**, not
 * `owner/repo` in the path and not a provider's word for either.
 */
export default new Action({
  name: 'ListWorkflows',
  description: 'List the workflows in a repository',
  method: 'GET',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    state: { rule: schema.string() },
    per_page: { rule: schema.number() },
    cursor: { rule: schema.string() },
  },

  responses: {
    200: {
      description: 'The workflows, by path, with the cursor for the next page. `next` is null on the last one rather than a cursor that returns nothing.',
      schema: {
        type: 'object',
        properties: {
          workflows: { type: 'array', items: { type: 'object' } },
          next: { type: 'string', nullable: true },
        },
      },
    },
    ...REPOSITORY_ERRORS,
    422: { description: 'A state this instance does not have, answered with the list of the ones it does.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'workflow:read')

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const state = String(request.get('state') ?? '').trim()

    if (state && state !== 'all' && !STATES.includes(state)) {
      return apiError('invalid_field', 'Unknown workflow state', {
        field: 'state',
        fix: `Use one of ${STATES.join(', ')}, or all.`,
      })
    }

    const size = pageSize(request.get('per_page'))
    const after = decodeCursor(request.get('cursor'))

    if (request.get('cursor') && !after) {
      return apiError('invalid_field', 'That cursor is not one we issued', {
        field: 'cursor',
        fix: 'Drop it and read the first page, or use the `next` value from a previous response.',
      })
    }

    let query = db
      .selectFrom('workflows')
      .select(['id', 'name', 'path', 'state', 'last_scheduled_at', 'created_at'])
      .where('repository_id', '=', repository.id)

    /*
     * `removed` is excluded unless it is asked for.
     *
     * A workflow whose file was deleted keeps its row so its finished runs stay
     * readable - a run pointing at nothing is a run nobody can explain - but it
     * is not part of what this repository does today, and listing it beside the
     * live ones is how somebody edits a file that is not there.
     */
    if (state && state !== 'all')
      query = query.where('state', '=', state)
    else if (!state)
      query = query.where('state', '!=', 'removed')

    const rows: any[] = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute()

    // The shared comparison rather than a second one written here: two
    // definitions of "after" is how a cursor skips a row in one endpoint and
    // repeats it in another, and it reads as a database problem.
    const ordered = rows.filter(row =>
      isAfter({ value: String(row.created_at ?? ''), id: Number(row.id) }, after, 'desc'),
    )

    const page = toPage(ordered, size, row => ({
      value: String(row.created_at ?? ''),
      id: Number(row.id),
    }))

    /*
     * The newest version of each, in one query rather than one per workflow.
     *
     * "Which definition is live" is the question immediately after "which
     * workflows are there", and a client that has to ask it per row turns a
     * page of twenty into twenty-one requests.
     */
    const ids = page.items.map(row => Number(row.id))

    const versions: any[] = ids.length > 0
      ? await db
        .selectFrom('workflow_versions')
        .select(['id', 'workflow_id', 'source_sha', 'source_path', 'content_digest', 'created_at'])
        .where('workflow_id', 'in', ids)
        .orderBy('id', 'desc')
        .execute()
        .catch(() => [])
      : []

    const newest = new Map<number, any>()

    for (const version of versions) {
      const workflowId = Number(version.workflow_id)

      if (!newest.has(workflowId))
        newest.set(workflowId, version)
    }

    return response.json({
      workflows: page.items.map(row => ({
        id: Number(row.id),
        name: row.name ?? null,
        path: row.path ?? null,
        state: String(row.state),
        last_scheduled_at: row.last_scheduled_at ?? null,
        created_at: row.created_at ?? null,
        version: newest.has(Number(row.id))
          ? {
              id: Number(newest.get(Number(row.id)).id),
              sha: newest.get(Number(row.id)).source_sha ?? null,
              path: newest.get(Number(row.id)).source_path ?? null,
              digest: newest.get(Number(row.id)).content_digest ?? null,
            }
          : null,
      })),
      next: page.nextCursor,
    })
  },
})
