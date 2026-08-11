import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { decodeCursor, isAfter, pageSize, toPage } from '../../Api/cursor'
import { apiError } from '../../Api/errors'
import { authorizeRepository } from '../Repo/authorize'

const STATES = ['queued', 'running', 'waiting', 'paused', 'cancelling', 'cancelled', 'failed', 'succeeded']

/**
 * The workflow runs in a repository.
 *
 * The list a person opens when they want to know whether their commit passed,
 * so the filters are the questions they actually ask: this branch, this commit,
 * this workflow, the ones still going, the ones that failed.
 *
 * Newest first, by `created_at` with the id as tiebreaker - the same total
 * ordering the other list endpoints use, through the same cursor helpers.
 * Two runs from one push share a timestamp to the second, and the id is what
 * stops them straddling a page boundary with one never returned.
 */
export default new Action({
  name: 'ListWorkflowRuns',
  description: 'List the workflow runs in a repository',
  method: 'GET',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    state: { rule: schema.string() },
    branch: { rule: schema.string() },
    sha: { rule: schema.string() },
    workflow: { rule: schema.number() },
    per_page: { rule: schema.number() },
    cursor: { rule: schema.string() },
  },

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context

    const state = String(request.get('state') ?? '').trim()
    if (state && state !== 'all' && !STATES.includes(state)) {
      return apiError('invalid_field', 'Unknown run state', {
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
      .selectFrom('workflow_runs')
      .select([
        'id', 'number', 'state', 'event', 'event_ref', 'head_sha',
        'definition_sha', 'trusted', 'workflow_version_id', 'pull_request_id',
        'started_at', 'finished_at', 'conclusion_reason', 'created_at',
      ])
      .where('repository_id', '=', repository.id)

    if (state && state !== 'all')
      query = query.where('state', '=', state)

    // A branch rather than a ref, because that is what somebody types. The
    // full ref is still accepted, so a link built from an event works too.
    const branch = String(request.get('branch') ?? '').trim()
    if (branch) {
      query = query.where('event_ref', '=', branch.startsWith('refs/') ? branch : `refs/heads/${branch}`)
    }

    const sha = String(request.get('sha') ?? '').trim()
    if (sha)
      query = query.where('head_sha', '=', sha)

    const workflow = Number(request.get('workflow'))
    if (Number.isFinite(workflow) && workflow > 0) {
      const versions: any[] = await db
        .selectFrom('workflow_versions')
        .select(['id'])
        .where('workflow_id', '=', workflow)
        .execute()

      const ids = versions.map(version => Number(version.id))

      // No versions means no runs, and an empty `IN` is not something to hand
      // to the database.
      if (ids.length === 0)
        return response.json({ workflow_runs: [], next: null })

      query = query.where('workflow_version_id', 'in', ids)
    }

    /*
     * Newest first, with the id as the tiebreaker. Both halves matter: two runs
     * from one push share a `created_at` to the second, and without the id they
     * straddle a page boundary and one is never returned - the exact failure
     * offset paging has, and the reason this uses a cursor at all.
     */
    const rows: any[] = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute()

    // The shared comparison rather than a second one written here. Two
    // definitions of "after" is how a cursor skips a row in one endpoint and
    // repeats it in another, and it reads as a database problem.
    const ordered = rows.filter(row =>
      isAfter({ value: String(row.created_at ?? ''), id: Number(row.id) }, after, 'desc'),
    )

    const page = toPage(ordered, size, row => ({
      value: String(row.created_at ?? ''),
      id: Number(row.id),
    }))

    return response.json({
      workflow_runs: page.items.map(shape),
      next: page.nextCursor,
    })
  },
})

/** One run, as the API describes it. */
function shape(row: any): Record<string, unknown> {
  return {
    id: Number(row.id),
    number: Number(row.number),
    state: String(row.state),
    event: String(row.event),
    ref: row.event_ref ?? null,
    head_sha: row.head_sha ?? null,
    /*
     * Which commit supplied the *workflow*, beside the one it is about. They
     * differ for a fork's pull request, and a reader who cannot see the
     * difference cannot tell a run of their code from a run of their code by
     * somebody else's workflow.
     */
    definition_sha: row.definition_sha ?? null,
    trusted: Boolean(row.trusted),
    workflow_version_id: Number(row.workflow_version_id),
    pull_request_id: row.pull_request_id ? Number(row.pull_request_id) : null,
    started_at: row.started_at ?? null,
    finished_at: row.finished_at ?? null,
    reason: row.conclusion_reason ?? null,
    created_at: row.created_at ?? null,
  }
}
