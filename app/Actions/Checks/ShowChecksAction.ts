import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS } from '../../Api/documented'
import { authorizeRepository } from '../Repo/authorize'
import { fromCheckRun, fromStatus, rollup } from './rollup'

/**
 * What every check has said about a commit, and the one answer that follows.
 *
 * By sha, or by pull request number - and the second is the one that gets used,
 * because a person asking "can this merge" knows the pull request and does not
 * know its head sha. Resolving it here rather than making the caller do it is
 * the difference between one request and two, and the two-request version has a
 * race in it: the head can move between them, and the caller gets checks for a
 * commit that is no longer the head without being told.
 *
 * The response carries the head sha it answered about for exactly that reason.
 * A client comparing it against what it thought the head was can tell the
 * difference between "these checks are green" and "these checks are green for a
 * commit somebody has already replaced".
 */
export default new Action({
  name: 'ShowChecks',
  description: 'Commit statuses and check runs for a commit or a pull request',
  method: 'GET',

  validations: {
    owner: { rule: schema.string().required() },
    repository: { rule: schema.string() },
    sha: { rule: schema.string() },
    number: { rule: schema.number() },
  },

  /*
   * What this answers with, for the generated document.
   *
   * The generator derives the *inputs* above and could derive nothing about
   * the output, so every operation in the document claimed a 200 of
   * `{"type": "object"}` and knew about no failure but 422 and 500 - and a
   * client generated from that has no branch for the 404 a private repository
   * answers, which is the one it will meet first.
   *
   * Written here rather than in a document kept in step by hand: this file is
   * where the shape is decided, and a description a hundred lines from the code
   * is one that is wrong within a month.
   */
  responses: {
    200: {
      description: 'Every check on the commit, and the one state that follows from them.',
      schema: {
        type: 'object',
        properties: {
          sha: { type: 'string', description: 'The commit these answers are about, so a client can tell "green" from "green for a commit somebody has replaced".' },
          state: { type: 'string', enum: ['success', 'failure', 'pending', 'neutral'] },
          counts: { type: 'object', description: 'How many checks are in each state.' },
          statuses: { type: 'array', items: { type: 'object' } },
          check_runs: { type: 'array', items: { type: 'object' } },
        },
      },
    },
    401: { description: 'No credential, or one this instance does not recognise.' },
    404: {
      description: 'No such repository, or one this caller may not see - deliberately the same answer, because distinguishing them tells a stranger that a private repository exists.',
    },
    422: { description: 'Neither a commit sha nor a pull request number was named.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:read')

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const number = Number(request.get('number') ?? 0)
    let sha = String(request.get('sha') ?? '').trim()

    if (number) {
      const pull = await db
        .selectFrom('pull_requests')
        .select(['head_sha', 'state'])
        .where('repository_id', '=', Number(repository.id))
        .where('number', '=', number)
        .executeTakeFirst()

      if (!pull)
        return response.json({ error: 'No such pull request' }, 404)

      sha = String(pull.head_sha ?? '')
    }

    if (!sha)
      return response.json({ error: 'Name a commit with sha, or a pull request with number.' }, 422)

    const statuses = await db
      .selectFrom('commit_statuses')
      .selectAll()
      .where('repository_id', '=', Number(repository.id))
      .where('sha', '=', sha)
      .orderBy('id', 'asc')
      .execute()

    const runs = await db
      .selectFrom('check_runs')
      .selectAll()
      .where('repository_id', '=', Number(repository.id))
      .where('head_sha', '=', sha)
      .orderBy('id', 'asc')
      .execute()

    /*
     * Statuses first, runs second, and both in id order.
     *
     * `latestPerName` breaks a tie towards the later entry, so a check run and
     * a status posting under the same name resolves to the run - which is the
     * right way round: a run carries a conclusion, output and annotations,
     * where a status is a dot. Ordering these two lists the other way would
     * silently prefer the poorer report.
     */
    const reports = [
      ...statuses.map((row, index) => fromStatus(row, index + 1)),
      ...runs.map(row => fromCheckRun(row)),
    ]

    const combined = rollup(reports)

    return response.json({
      // The commit these answers are about, so a client can tell "green" from
      // "green for a commit somebody has already replaced".
      sha,
      state: combined.state,
      counts: combined.counts,
      statuses: statuses.map(row => ({
        context: String(row.context),
        state: String(row.state),
        target_url: row.target_url ? String(row.target_url) : null,
        description: row.description ? String(row.description) : null,
        created_at: row.created_at ? String(row.created_at) : null,
      })),
      check_runs: await Promise.all(runs.map(async row => ({
        id: Number(row.id),
        name: String(row.name),
        status: String(row.status),
        conclusion: row.conclusion ? String(row.conclusion) : null,
        provider: row.provider ? String(row.provider) : null,
        attempt: Number(row.attempt) || 1,
        details_url: row.details_url ? String(row.details_url) : null,
        summary: row.summary ? String(row.summary) : null,
        started_at: row.started_at ? String(row.started_at) : null,
        completed_at: row.completed_at ? String(row.completed_at) : null,
        annotations: await annotationsFor(Number(row.id)),
      }))),
    })
  },
})

/**
 * The annotations on a run, which are the reason any of this is on a diff.
 *
 * Capped at a hundred per run in the response. A linter that reports four
 * thousand findings is a linter whose findings nobody is going to read one by
 * one, and a response carrying all of them is a page that does not render - so
 * the count is reported alongside the sample rather than the sample being
 * passed off as everything.
 */
async function annotationsFor(checkRunId: number): Promise<{ total: number, items: unknown[] }> {
  try {
    const rows = await db
      .selectFrom('check_annotations')
      .selectAll()
      .where('check_run_id', '=', checkRunId)
      .orderBy('path', 'asc')
      .orderBy('start_line', 'asc')
      .execute()

    return {
      total: rows.length,
      items: rows.slice(0, 100).map(row => ({
        path: String(row.path),
        start_line: Number(row.start_line),
        end_line: Number(row.end_line),
        side: String(row.side),
        level: String(row.level),
        title: row.title ? String(row.title) : null,
        message: String(row.message),
      })),
    }
  }
  catch {
    return { total: 0, items: [] }
  }
}
