/**
 * A deployment's history, and telling programs about it.
 *
 * The deployment row says where it got to; these rows say how it got there. A
 * column holding the current state answers "is production up" and cannot answer
 * "when did it go down, and what did the job say" - and the second is the one
 * asked at the point where it matters, which is always afterwards.
 *
 * Kept out of the action for the reason the rest of `app/Actions` splits this
 * way: the endpoint decides who may do a thing, and this decides what the thing
 * writes. A deploy job, a pull request closing, and a rollback all produce
 * statuses, and only one of them arrives through that endpoint.
 */

import { db } from '@stacksjs/database'
import { notifyProgramsOnly } from '../../Notifications/emit'

/** What a status may say. Wider than a deployment's own state, and deliberately. */
export type StatusState = 'queued' | 'in_progress' | 'active' | 'failed' | 'inactive' | 'rolled_back'

const STATES: readonly string[] = ['queued', 'in_progress', 'active', 'failed', 'inactive', 'rolled_back']

/**
 * Write down what just happened to a deployment.
 *
 * Never throws. A status is a record of something that has already happened -
 * the row it describes is already written - and failing the request that made
 * it would report an error for work that was done.
 */
export async function recordStatus(input: {
  deploymentId: number
  repositoryId: number
  state: string
  description?: string | null
  url?: string | null
  /** The deployment this one put back, when it is a rollback. */
  restoredDeploymentId?: number | null
  actorId?: number | null
}): Promise<void> {
  if (!Number.isInteger(input.deploymentId) || input.deploymentId <= 0)
    return

  const state = STATES.includes(String(input.state)) ? String(input.state) : 'in_progress'

  await db
    .insertInto('deployment_statuses')
    .values({
      deployment_id: input.deploymentId,
      repository_id: input.repositoryId,
      state,
      // Bounded here rather than trusted from the caller: a deploy job is
      // somebody else's program, and a status carrying a stack trace would push
      // every other line off the screen it is read on.
      description: String(input.description ?? '').slice(0, 1000) || null,
      url: String(input.url ?? '').slice(0, 500) || null,
      restored_deployment_id: input.restoredDeploymentId ?? null,
      actor_id: input.actorId ?? null,
    })
    .execute()
    .catch(() => null)
}

/**
 * Tell the programs waiting on it.
 *
 * The event a deployment dashboard, a chat channel and the next stage of a
 * pipeline all wait on, and the alternative is each of them polling a history
 * endpoint. `action` carries the state, like every other event here, so one
 * subscription covers recorded through rolled back.
 *
 * Read back from the row rather than taking the caller's word: whatever else
 * moved in the same request, the event should describe what is true.
 */
export async function announceDeployment(repositoryId: number, deploymentId: number, state: string): Promise<void> {
  try {
    if (!deploymentId)
      return

    const row: any = await db
      .selectFrom('deployments')
      .select(['id', 'environment', 'head_sha', 'ref', 'url', 'state', 'pull_request_id', 'workflow_run_id'])
      .where('id', '=', deploymentId)
      .executeTakeFirst()

    if (!row)
      return

    const repository: any = await db
      .selectFrom('repositories')
      .select(['name', 'owner_type', 'owner_id'])
      .where('id', '=', repositoryId)
      .executeTakeFirst()

    if (!repository)
      return

    const owner: any = String(repository.owner_type) === 'user'
      ? await db.selectFrom('users').select(['handle']).where('id', '=', Number(repository.owner_id)).executeTakeFirst()
      : await db.selectFrom('organizations').select(['handle']).where('id', '=', Number(repository.owner_id)).executeTakeFirst()

    await notifyProgramsOnly('deployment:status', {
      // Nobody clicked, in the general case: a deploy job reports this. Zero
      // reads as "the system" to every consumer.
      actorId: 0,
      actorHandle: '',
      repositoryId,
      owner: String(owner?.handle ?? ''),
      repository: String(repository.name ?? ''),
      // The repository, not a fourth subject type for a receiver to learn.
      subjectType: 'repository',
      subjectId: repositoryId,
      title: `${row.environment} is ${state}`,
      action: state,
      deployment: {
        id: Number(row.id),
        environment: String(row.environment),
        state: String(row.state),
        head_sha: String(row.head_sha ?? ''),
        ref: String(row.ref ?? ''),
        url: String(row.url ?? ''),
        pull_request: row.pull_request_id ? Number(row.pull_request_id) : null,
        run_id: row.workflow_run_id ? Number(row.workflow_run_id) : null,
      },
    } as any)
  }
  catch (error) {
    console.error('[deploy] could not announce a deployment:', error)
  }
}
