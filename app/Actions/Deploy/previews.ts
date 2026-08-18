/**
 * Previews, and the day they stop being useful.
 *
 * A preview is a deployment with a pull request on it, which is what makes
 * expiry a fact rather than a feature: the thing it belongs to closed, so it is
 * no longer current. Nothing here deletes a row - "what was on this URL last
 * Tuesday" is a question somebody asks, and expressing "not running any more"
 * by removing the history answers it with silence.
 */

import { db } from '@stacksjs/database'

/** The states a deployment is in while it still means something. */
export const LIVE_STATES = ['in_progress', 'active'] as const

/**
 * Mark every preview whose pull request has ended.
 *
 * Called when a pull request merges or closes, and again whenever a deployment
 * is recorded. The second is not belt and braces: a preview recorded by a job
 * that finished *after* the pull request merged would otherwise stay active
 * forever, and a slow deploy finishing after the merge is the ordinary case
 * rather than the rare one.
 */
export async function expirePreviews(repositoryId: number, pullRequestId?: number): Promise<number> {
  /*
   * Built in two steps rather than one chain: the narrowing by pull request is
   * conditional, and the builder this instance is on has no `$call` to hang a
   * conditional clause off. (It does now, upstream - this stays plain until the
   * release lands, because a query that throws here is a preview that never
   * expires.)
   */
  let query = db
    .selectFrom('deployments')
    .innerJoin('pull_requests', 'pull_requests.id', '=', 'deployments.pull_request_id')
    .select([
      'deployments.id as id',
      'pull_requests.state as pull_state',
      'pull_requests.merged_at as merged_at',
    ])
    .where('deployments.repository_id', '=', repositoryId)
    .where('deployments.state', 'in', [...LIVE_STATES])

  if (pullRequestId)
    query = query.where('deployments.pull_request_id', '=', pullRequestId)

  const live = await query.execute().catch(() => [])

  const ended = live.filter(row => String(row.pull_state) !== 'open')

  for (const row of ended) {
    await db
      .updateTable('deployments')
      .set({
        state: 'inactive',
        // Which of the two, because they mean different things to whoever
        // reads the history: merged means it shipped, closed means it did not.
        reason: row.merged_at ? 'the pull request merged' : 'the pull request closed',
        finished_at: new Date().toISOString(),
      })
      .where('id', '=', Number(row.id))
      .where('state', 'in', [...LIVE_STATES])
      .execute()
      .catch(() => null)
  }

  return ended.length
}

export interface PreviewLink {
  environment: string
  url: string
  state: string
  sha: string
  run: number | null
}

/**
 * The preview to show on a pull request, if there is one.
 *
 * The newest live one per environment, because a branch pushed to five times
 * has five recorded and four of them point at a URL that no longer answers.
 * Deployments with no URL are left out: this is a link on a page, and a link to
 * nothing is worse than no link.
 */
export async function previewsFor(pullRequestId: number): Promise<PreviewLink[]> {
  const rows = await db
    .selectFrom('deployments')
    .select(['environment', 'url', 'state', 'head_sha', 'workflow_run_id'])
    .where('pull_request_id', '=', pullRequestId)
    .where('state', 'in', [...LIVE_STATES])
    .orderBy('id', 'desc')
    .execute()
    .catch(() => [])

  const newest = new Map<string, PreviewLink>()

  for (const row of rows) {
    const environment = String(row.environment)

    if (!String(row.url ?? '') || newest.has(environment))
      continue

    newest.set(environment, {
      environment,
      url: String(row.url),
      state: String(row.state),
      sha: String(row.head_sha ?? ''),
      run: row.workflow_run_id ? Number(row.workflow_run_id) : null,
    })
  }

  return [...newest.values()]
}
