import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { schema } from '@stacksjs/validation'
import { RATE_LIMIT_HEADERS, REPOSITORY_ERRORS } from '../../Api/documented'
import { auditEvent } from '../../Audit/events'
import { auditFrom } from '../Git/audit'
import { authorizeRepository } from '../Repo/authorize'
import { expirePreviews } from './previews'
import { announceDeployment, recordStatus } from './statuses'
import type { Health } from './stages'
import { decideStage, stagesFrom } from './stages'
import { isTrue } from '../Support/sql'

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
    operation: { rule: schema.enum(['list', 'create', 'update', 'deactivate', 'rollback', 'history', 'health', 'hold', 'resume']) },
    environment: { rule: schema.string(), required: false },
    sha: { rule: schema.string(), required: false },
    ref: { rule: schema.string(), required: false },
    url: { rule: schema.string(), required: false },
    state: { rule: schema.enum(['in_progress', 'active', 'failed', 'inactive']), required: false },
    /** What the job wants to say about this status, in one line. */
    description: { rule: schema.string(), required: false },
    /**
     * The rollout, when a deployment arrives in stages: `10,50,100`, or
     * `canary:10, half:50, all:100` when the names are worth having.
     */
    stages: { rule: schema.string(), required: false },
    /** What the health check said: `healthy`, `unhealthy`, or nothing yet. */
    health: { rule: schema.string(), required: false },
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

    /*
     * A health check reporting, which is what moves a staged rollout.
     *
     * The decision is `decideStage` rather than anything written here: promote,
     * hold or go back is the rule people argue about during an incident, and an
     * argument settled by reading a test is shorter than one settled by
     * re-running a deployment.
     */
    if (operation === 'health' || operation === 'hold' || operation === 'resume') {
      const id = Number(request.get('id'))

      if (!Number.isInteger(id) || id <= 0)
        return response.json({ error: 'Which deployment?' }, 422)

      const deployment: any = await db
        .selectFrom('deployments')
        .select(['id', 'environment', 'head_sha', 'ref', 'url', 'stages', 'stage_index', 'stage_held', 'workflow_run_id'])
        .where('id', '=', id)
        .where('repository_id', '=', repositoryId)
        .executeTakeFirst()

      if (!deployment)
        return response.json({ error: 'No such deployment' }, 404)

      if (operation === 'hold' || operation === 'resume') {
        const held = operation === 'hold'

        await db.updateTable('deployments').set({ stage_held: held }).where('id', '=', id).execute()

        await recordStatus({
          deploymentId: id,
          repositoryId,
          // Still `in_progress`: a held rollout is serving whatever share it
          // reached, and a state saying otherwise would be the dangerous
          // direction to be wrong in.
          state: 'in_progress',
          description: held ? 'Held where it is.' : 'Released to continue.',
          actorId: auth.context.user?.id ?? null,
        })

        return response.json({ deployment: { id, held }, stages: stagesFrom(deployment.stages) })
      }

      const stages = stagesFrom(deployment.stages)
      const current = Number(deployment.stage_index ?? 0) || 0
      const health = healthFrom(request.get('health'))

      const verdict = decideStage({ stages, current, health, held: isTrue(deployment.stage_held) })

      await recordStatus({
        deploymentId: id,
        repositoryId,
        state: verdict.action === 'roll-back' ? 'failed' : 'in_progress',
        description: `Health: ${health}. ${verdict.reason}`,
        actorId: auth.context.user?.id ?? null,
      })

      if (verdict.action === 'promote') {
        await db
          .updateTable('deployments')
          .set({ stage_index: current + 1, state: 'active' })
          .where('id', '=', id)
          .execute()

        await recordStatus({
          deploymentId: id,
          repositoryId,
          state: 'active',
          description: `${verdict.stage.name} is serving ${verdict.stage.percent}%.`,
          actorId: auth.context.user?.id ?? null,
        })
      }

      if (verdict.action === 'complete') {
        await db
          .updateTable('deployments')
          .set({ state: 'active' })
          .where('id', '=', id)
          .execute()
      }

      /*
       * A failed check puts the previous deployment back, through the same
       * path a person's rollback takes - so the history reads identically
       * whether a graph or a human decided, and there is one code path that
       * knows what restoring means.
       */
      if (verdict.action === 'roll-back') {
        const previous: any = await db
          .selectFrom('deployments')
          .select(['id'])
          .where('repository_id', '=', repositoryId)
          .where('environment', '=', String(deployment.environment))
          .where('id', '!=', id)
          .orderBy('id', 'desc')
          .executeTakeFirst()
          .catch(() => null)

        await db
          .updateTable('deployments')
          .set({ state: 'failed', reason: verdict.reason, finished_at: new Date().toISOString() })
          .where('id', '=', id)
          .execute()

        if (previous?.id)
          await restoreDeployment(repositoryId, Number(previous.id), auth.context.user?.id ?? null)
      }

      await announceDeployment(repositoryId, id, verdict.action)

      return response.json({
        deployment: { id, stage_index: verdict.action === 'promote' ? current + 1 : current },
        verdict: verdict.action,
        reason: verdict.reason,
        stages,
      })
    }

    if (operation === 'history') {
      const id = Number(request.get('id'))

      if (!Number.isInteger(id) || id <= 0)
        return response.json({ error: 'Which deployment?' }, 422)

      return response.json({ statuses: await historyOf(repositoryId, id) })
    }

    /*
     * Putting an earlier deployment back.
     *
     * Recorded as a *new* deployment of the old commit rather than by reviving
     * the old row, because that is what happened: something was deployed today,
     * and it happens to be what was deployed last Tuesday. Reviving the row
     * would leave a history in which Tuesday's deployment ran for a week with a
     * gap in the middle, which is not a thing that occurred.
     *
     * The status on it names what it restored, so "rollback records the version
     * restored" is a column rather than a sentence somebody wrote into a
     * description and hoped to parse later.
     */
    if (operation === 'rollback') {
      const id = Number(request.get('id'))

      if (!Number.isInteger(id) || id <= 0)
        return response.json({ error: 'Which deployment should be restored?' }, 422)

      const restored = await db
        .selectFrom('deployments')
        .select(['id', 'environment', 'head_sha', 'ref', 'url', 'workflow_run_id'])
        .where('id', '=', id)
        .where('repository_id', '=', repositoryId)
        .executeTakeFirst()

      if (!restored)
        return response.json({ error: 'No such deployment' }, 404)

      // Whatever is live in that environment stops being live, in the same
      // pass: two active deployments of one environment is a listing that
      // cannot say what is running.
      await db
        .updateTable('deployments')
        .set({ state: 'inactive', reason: `rolled back to deployment ${id}`, finished_at: new Date().toISOString() })
        .where('repository_id', '=', repositoryId)
        .where('environment', '=', String(restored.environment))
        .where('state', 'in', ['in_progress', 'active'])
        .execute()

      const again = await db
        .insertInto('deployments')
        .values({
          repository_id: repositoryId,
          environment: String(restored.environment),
          head_sha: String(restored.head_sha),
          ref: String(restored.ref ?? ''),
          workflow_run_id: restored.workflow_run_id ?? null,
          url: String(restored.url ?? ''),
          state: 'active',
          reason: `restored from deployment ${id}`,
          created_by_id: auth.context.user?.id ?? null,
        })
        .returning(['id'])
        .executeTakeFirst()

      await recordStatus({
        deploymentId: Number(again?.id ?? 0),
        repositoryId,
        state: 'rolled_back',
        description: `restored from deployment ${id}`,
        url: String(restored.url ?? ''),
        restoredDeploymentId: id,
        actorId: auth.context.user?.id ?? null,
      })

      await auditEvent('deployment:updated', {
        subject: { type: 'repository', id: repositoryId },
        actorId: auth.context.user?.id ?? null,
        ...await auditFrom(request),
        repositoryId,
        detail: { deployment: Number(again?.id ?? 0), environment: String(restored.environment), state: 'rolled_back', restored: id },
      }).catch(() => null)

      await announceDeployment(repositoryId, Number(again?.id ?? 0), 'rolled_back')

      return response.json({
        deployment: { id: Number(again?.id ?? 0), environment: String(restored.environment), state: 'active', restored: id },
        deployments: await listDeployments(repositoryId, '', 30),
      })
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

      /*
       * And the history of how it got there, which the column cannot carry.
       *
       * A deployment that went `in_progress` -> `failed` -> `in_progress` ->
       * `active` is four facts, and a row that overwrites itself keeps one of
       * them - the one nobody is asking about by the time they ask.
       */
      await recordStatus({
        deploymentId: id,
        repositoryId,
        state,
        description: String(request.get('description') ?? reason ?? ''),
        url: request.get('url') === undefined ? null : String(request.get('url') ?? ''),
        actorId: auth.context.user?.id ?? null,
      })

      await auditEvent('deployment:updated', {
        subject: { type: 'repository', id: repositoryId },
        actorId: auth.context.user?.id ?? null,
        ...await auditFrom(request),
        repositoryId,
        detail: { deployment: id, environment: String(existing.environment), state, reason },
      }).catch(() => null)

      await announceDeployment(repositoryId, id, state)

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
        /*
         * The rollout, stored as written. A plan is a sentence about intent,
         * and expanding it into rows would be four records that can disagree
         * with the deployment they belong to.
         */
        stages: String(request.get('stages') ?? '').slice(0, 500) || null,
      })
      .returning(['id'])
      .executeTakeFirst()

    await recordStatus({
      deploymentId: Number(created?.id ?? 0),
      repositoryId,
      state: String(request.get('state') ?? 'in_progress'),
      description: String(request.get('description') ?? ''),
      url: String(request.get('url') ?? ''),
      actorId: auth.context.user?.id ?? null,
    })

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

    await announceDeployment(repositoryId, Number(created?.id ?? 0), String(request.get('state') ?? 'in_progress'))

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

/** One deployment's history, oldest first, which is the order it happened in. */
async function historyOf(repositoryId: number, deploymentId: number): Promise<Array<Record<string, unknown>>> {
  const rows = await db
    .selectFrom('deployment_statuses')
    .select(['id', 'state', 'description', 'url', 'restored_deployment_id', 'actor_id', 'created_at'])
    .where('repository_id', '=', repositoryId)
    .where('deployment_id', '=', deploymentId)
    .orderBy('id')
    .limit(200)
    .execute()
    .catch(() => [])

  return rows.map(row => ({
    id: Number(row.id),
    state: String(row.state),
    description: String(row.description ?? ''),
    url: String(row.url ?? ''),
    /** The deployment this one put back, when it is a rollback. */
    restored: row.restored_deployment_id ? Number(row.restored_deployment_id) : null,
    at: row.created_at ? String(row.created_at) : null,
  }))
}

/**
 * Put an earlier deployment back, as a new deployment of the old commit.
 *
 * Shared by the operation a person calls and by the automatic rollback a failed
 * health check triggers, so the history reads identically whether a graph or a
 * human decided - and there is one place that knows what "restored" means.
 *
 * A new row rather than the old one revived, because that is what happened:
 * something was deployed today, and it happens to be what was deployed before.
 * Reviving would leave a history in which the older deployment ran for a week
 * with a gap in the middle, which is not a thing that occurred.
 */
async function restoreDeployment(repositoryId: number, restoreId: number, actorId: number | null): Promise<number> {
  const restored: any = await db
    .selectFrom('deployments')
    .select(['id', 'environment', 'head_sha', 'ref', 'url', 'workflow_run_id'])
    .where('id', '=', restoreId)
    .where('repository_id', '=', repositoryId)
    .executeTakeFirst()
    .catch(() => null)

  if (!restored)
    return 0

  // Whatever is live in that environment stops being live in the same pass:
  // two active deployments of one environment is a listing that cannot say
  // what is running.
  await db
    .updateTable('deployments')
    .set({ state: 'inactive', reason: `rolled back to deployment ${restoreId}`, finished_at: new Date().toISOString() })
    .where('repository_id', '=', repositoryId)
    .where('environment', '=', String(restored.environment))
    .where('state', 'in', ['in_progress', 'active'])
    .execute()

  const again: any = await db
    .insertInto('deployments')
    .values({
      repository_id: repositoryId,
      environment: String(restored.environment),
      head_sha: String(restored.head_sha),
      ref: String(restored.ref ?? ''),
      workflow_run_id: restored.workflow_run_id ?? null,
      url: String(restored.url ?? ''),
      state: 'active',
      reason: `restored from deployment ${restoreId}`,
      created_by_id: actorId,
    })
    .returning(['id'])
    .executeTakeFirst()
    .catch(() => null)

  if (!again?.id)
    return 0

  await recordStatus({
    deploymentId: Number(again.id),
    repositoryId,
    state: 'rolled_back',
    description: `restored from deployment ${restoreId}`,
    url: String(restored.url ?? ''),
    restoredDeploymentId: restoreId,
    actorId,
  })

  return Number(again.id)
}

/**
 * What a caller said about the health of a stage.
 *
 * Anything that is not plainly one of the two is `unknown`, which holds. A
 * probe that answered with a shrug must not promote on no evidence, and must
 * not roll back a deployment that is fine - both are worse than waiting for the
 * next report.
 */
function healthFrom(value: unknown): Health {
  const said = String(value ?? '').trim().toLowerCase()

  if (said === 'healthy' || said === 'pass' || said === 'passing' || said === 'true')
    return 'healthy'

  if (said === 'unhealthy' || said === 'fail' || said === 'failing' || said === 'false')
    return 'unhealthy'

  return 'unknown'
}
