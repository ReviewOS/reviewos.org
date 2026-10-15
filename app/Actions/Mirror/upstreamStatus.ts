/**
 * A mirror's CI verdict, reported where the commit came from.
 *
 * A mirror that runs its workflows here (`run_workflows`) is one whose owners
 * moved their CI to this instance while the code still lives upstream. The
 * people pushing there look for red and green on the commit and the pull
 * request there; a verdict that only exists here is one they never see, and a
 * branch protection rule upstream cannot wait for it. So every run transition
 * on such a mirror becomes a commit status on the upstream commit - `pending`
 * while it waits or runs, then `success`, `failure` or `error`.
 *
 * Only with a credential that may write statuses, which is the token the
 * mirror already fetches with (`credential_ref`). Never throws: a status is a
 * courtesy to the upstream, and a GitHub outage must not be able to fail the
 * report, the claim or the sweep that moved the run.
 */

import { db } from '@stacksjs/database'
import { isTrue } from '../Support/sql'

export type UpstreamState = 'pending' | 'success' | 'failure' | 'error'

/**
 * A run's state, as GitHub's four status states.
 *
 * `cancelled` is `error` rather than `failure`: nothing the commit did failed,
 * the run was stopped - usually because a newer push superseded it - and a
 * red cross on a commit nobody broke sends somebody looking for a bug that
 * does not exist.
 */
export function upstreamStateFor(state: string): UpstreamState | null {
  switch (state) {
    case 'queued':
    case 'waiting':
    case 'paused':
    case 'running':
    case 'cancelling':
      return 'pending'
    case 'succeeded':
      return 'success'
    case 'failed':
      return 'failure'
    case 'cancelled':
      return 'error'
    default:
      return null
  }
}

/** The sentence beside the status, short enough for GitHub's 140 characters. */
export function upstreamDescription(number: number, state: string): string {
  switch (state) {
    case 'queued':
      return `Run ${number} is waiting for a runner`
    case 'waiting':
    case 'paused':
      return `Run ${number} is waiting`
    case 'running':
      return `Run ${number} is running`
    case 'cancelling':
    case 'cancelled':
      return `Run ${number} was cancelled`
    case 'succeeded':
      return `Run ${number} passed`
    case 'failed':
      return `Run ${number} failed`
    default:
      return `Run ${number} is ${state}`
  }
}

export interface UpstreamRun {
  id: number
  number: number
  state: string
  headSha?: string | null
}

/** Report one run's state on its upstream commit, when its repository is a CI mirror. */
export async function reportRunUpstream(repositoryId: number, run: UpstreamRun, fetchImpl?: typeof fetch): Promise<void> {
  try {
    const sha = String(run.headSha ?? '')
    const state = upstreamStateFor(String(run.state))
    if (!/^[0-9a-f]{40}$/i.test(sha) || !state)
      return

    const mirror: any = await db
      .selectFrom('repository_mirrors')
      .select(['provider', 'remote_owner', 'remote_name', 'credential_ref', 'run_workflows'])
      .where('repository_id', '=', repositoryId)
      .executeTakeFirst()

    if (!mirror || !isTrue(mirror.run_workflows) || String(mirror.provider ?? 'github') !== 'github')
      return

    const { mirrorToken } = await import('./credentials')
    const token = await mirrorToken(mirror.credential_ref)
    if (!token)
      return

    const facts = await runFacts(repositoryId, Number(run.id))
    const { GitHubClient } = await import('./github-client')
    const client = new GitHubClient({ token, fetchImpl })

    const answer = await client.postStatus({
      owner: String(mirror.remote_owner),
      name: String(mirror.remote_name),
      sha,
      state,
      context: `ReviewOS / ${facts.workflow || 'CI'}`,
      description: upstreamDescription(Number(run.number), String(run.state)),
      targetUrl: facts.url,
    })

    if (!answer.ok)
      console.error(`[mirror] could not report run ${run.number} upstream: ${answer.status} ${answer.message}`)
  }
  catch (error) {
    console.error('[mirror] could not report a run upstream:', error)
  }
}

/** The workflow's name and the run's page here, for the status's context and link. */
async function runFacts(repositoryId: number, runId: number): Promise<{ workflow: string, url: string | null }> {
  const row: any = await db
    .selectFrom('workflow_runs')
    .innerJoin('workflow_versions', 'workflow_versions.id', '=', 'workflow_runs.workflow_version_id')
    .innerJoin('workflows', 'workflows.id', '=', 'workflow_versions.workflow_id')
    .select(['workflows.name as workflow', 'workflow_runs.number as number'])
    .where('workflow_runs.id', '=', runId)
    .executeTakeFirst()
    .catch(() => null)

  const repository: any = await db
    .selectFrom('repositories')
    .select(['name', 'owner_type', 'owner_id'])
    .where('id', '=', repositoryId)
    .executeTakeFirst()

  const table = String(repository?.owner_type) === 'user' ? 'users' : 'organizations'
  const owner: any = repository
    ? await db.selectFrom(table as any).select(['handle']).where('id', '=', Number(repository.owner_id)).executeTakeFirst()
    : null

  const base = String(process.env.APP_URL ?? '').trim().replace(/\/$/, '')
  const url = base && owner?.handle && repository?.name && row?.number
    ? `${base}/${owner.handle}/${repository.name}/run/${row.number}`
    : null

  return { workflow: String(row?.workflow ?? ''), url }
}
