import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { auditEvent } from '../../Audit/events'
import { auditFrom } from '../Git/audit'
import { authorizeRepository } from '../Repo/authorize'
import { expirePreviews } from './previews'

/**
 * Recording what was put where.
 *
 * This instance never deploys anything. A job does, with credentials the
 * environment released to it, and then calls this to say what happened: which
 * commit, which environment, what URL came out. So the row is provenance, and
 * the history is what somebody reads when a page is wrong on a Monday and
 * nobody remembers what shipped on Friday.
 *
 * **A preview is the same row with a pull request on it.** Not a second model,
 * which is what the roadmap asks for and what makes expiry free: a pull request
 * that merges or closes takes its previews with it, because they belong to it
 * rather than sitting in a table of their own with a sweeper that has to be
 * kept in step.
 *
 * Creating one takes the same ability as opening a gate. A deployment record is
 * what a branch rule, a dashboard and the next reviewer all read, and something
 * that can write "production is on this commit" is saying where the product is.
 */
export default new Action({
  name: 'Deployments',
  description: 'Record a deployment, update its state, or read the history',
  method: 'POST',

  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    operation: { rule: schema.enum(['list', 'create', 'update', 'deactivate']) },
    environment: { rule: schema.string(), required: false },
    sha: { rule: schema.string(), required: false },
    ref: { rule: schema.string(), required: false },
    url: { rule: schema.string(), required: false },
    state: { rule: schema.enum(['in_progress', 'active', 'failed', 'inactive']), required: false },
    pull_request: { rule: schema.number(), required: false },
    run: { rule: schema.number(), required: false },
    reason: { rule: schema.string(), required: false },
    id: { rule: schema.number(), required: false },
    limit: { rule: schema.number(), required: false },
  },

  responses: {
    200: { description: 'The deployments this repository has, newest first.' },
    ...REPOSITORY_ERRORS,
    422: { description: 'A deployment needs an environment and a commit.' },
  },

  responseHeaders: RATE_LIMIT_HEADERS,

  async handle(request: RequestInstance) {
    const operation = String(request.get('operation') ?? 'list').trim() || 'list'

    /*
     * Reading takes what reading a run takes; writing takes what opening a gate
     * takes. Recording "production is on this commit" is saying where the
     * product is, and a token that may report a check should not be able to.
     */
    const auth = await authorizeRepository(request, operation === 'list' ? 'workflow:read' : 'workflow:approve')

    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const repositoryId = Number(auth.context.repository.id)

    if (operation === 'list') {
      const environment = String(request.get('environment') ?? '').trim()
      const asked = Number(request.get('limit'))
      const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 100) : 30

      return response.json({ deployments: await listDeployments(repositoryId, environment, limit) })
    }

    if (operation === 'deactivate' || operation === 'update') {
      const id = Number(request.get('id'))

      if (!Number.isInteger(id) || id <= 0)
        return response.json({ error: 'Which deployment?' }, 422)

      const existing = await db
        .selectFrom('deployments')
        .select(['id', 'environment'])
        .where('id', '=', id)
        .where('repository_id', '=', repositoryId)
        .executeTakeFirst()

      if (!existing)
        return response.json({ error: 'No such deployment' }, 404)

      const state = operation === 'deactivate' ? 'inactive' : String(request.get('state') ?? 'active')
      const reason = String(request.get('reason') ?? '').slice(0, 500)

      await db
        .updateTable('deployments')
        .set({
          state,
          ...(reason ? { reason } : {}),
          ...(request.get('url') === undefined ? {} : { url: String(request.get('url') ?? '').slice(0, 500) }),
          // Stamped when it stops being current, so a listing can say "until
          // Friday" rather than leaving a reader to infer it from the next row.
          ...(state === 'inactive' || state === 'failed' ? { finished_at: new Date().toISOString() } : {}),
        })
        .where('id', '=', id)
        .execute()

      await auditEvent('deployment:updated', {
        subject: { type: 'repository', id: repositoryId },
        actorId: auth.context.user?.id ?? null,
        ...await auditFrom(request),
        repositoryId,
        detail: { deployment: id, environment: String(existing.environment), state, reason },
      }).catch(() => null)

      return response.json({ deployments: await listDeployments(repositoryId, '', 30) })
    }

    const environment = String(request.get('environment') ?? '').trim()
    const sha = String(request.get('sha') ?? '').trim()

    if (!environment || !sha)
      return response.json({ error: 'A deployment needs an environment and a commit' }, 422)

    const pullRequest = Number(request.get('pull_request')) || null

    /*
     * A pull request's previous preview of the same environment is deactivated
     * as this one is recorded.
     *
     * Otherwise a branch pushed to five times has five active previews, four of
     * them pointing at URLs that no longer answer - and the pull request shows
     * whichever the query happened to order first.
     */
    if (pullRequest) {
      await db
        .updateTable('deployments')
        .set({ state: 'inactive', reason: 'replaced by a newer preview', finished_at: new Date().toISOString() })
        .where('repository_id', '=', repositoryId)
        .where('pull_request_id', '=', pullRequest)
        .where('environment', '=', environment)
        .where('state', 'in', ['in_progress', 'active'])
        .execute()
    }

    const created = await db
      .insertInto('deployments')
      .values({
        repository_id: repositoryId,
        environment: environment.slice(0, 120),
        head_sha: sha.slice(0, 64),
        ref: String(request.get('ref') ?? '').slice(0, 255),
        pull_request_id: pullRequest,
        workflow_run_id: Number(request.get('run')) || null,
        url: String(request.get('url') ?? '').slice(0, 500),
        state: String(request.get('state') ?? 'in_progress'),
        created_by_id: auth.context.user?.id ?? null,
      })
      .returning(['id'])
      .executeTakeFirst()

    await auditEvent('deployment:recorded', {
      subject: { type: 'repository', id: repositoryId },
      actorId: auth.context.user?.id ?? null,
      ...await auditFrom(request),
      repositoryId,
      detail: { deployment: Number(created?.id ?? 0), environment, sha, pull_request: pullRequest },
    }).catch(() => null)

    /*
     * And a sweep of anything whose pull request has since closed, here rather
     * than only on the close itself: a preview recorded by a job that finished
     * after the pull request merged would otherwise stay active forever, and
     * that ordering is the ordinary one for a slow deploy.
     */
    await expirePreviews(repositoryId).catch(() => null)

    return response.json({
      deployment: { id: Number(created?.id ?? 0), environment, state: String(request.get('state') ?? 'in_progress') },
      deployments: await listDeployments(repositoryId, '', 30),
    })
  },
})

/** The history, newest first, in the shape a page and a program both read. */
async function listDeployments(repositoryId: number, environment: string, limit: number): Promise<Array<Record<string, unknown>>> {
  let query = db
    .selectFrom('deployments')
    .select(['id', 'environment', 'head_sha', 'ref', 'pull_request_id', 'workflow_run_id', 'url', 'state', 'reason', 'created_at', 'finished_at'])
    .where('repository_id', '=', repositoryId)

  if (environment)
    query = query.where('environment', '=', environment)

  const rows = await query.orderBy('id', 'desc').limit(limit).execute().catch(() => [])

  return rows.map(row => ({
    id: Number(row.id),
    environment: String(row.environment),
    head_sha: String(row.head_sha),
    ref: String(row.ref ?? ''),
    pull_request: row.pull_request_id ? Number(row.pull_request_id) : null,
    run: row.workflow_run_id ? Number(row.workflow_run_id) : null,
    url: String(row.url ?? ''),
    state: String(row.state),
    reason: String(row.reason ?? ''),
    at: row.created_at ? String(row.created_at) : null,
    until: row.finished_at ? String(row.finished_at) : null,
  }))
}
