import { db } from '@stacksjs/database'
import { settleRun } from './settle'

/**
 * Letting go of deploys whose wait timer has run out.
 *
 * A timer that needs a person to end it is a second approval wearing a clock,
 * so the sweep is what makes "wait ten minutes" mean anything. It moves a held
 * job back to `blocked` and re-settles the run, which re-asks the same gate
 * with the same code that decided to hold it - rather than queueing the job
 * here and becoming a second place that knows what an environment means.
 *
 * A job still waiting on a reviewer is untouched: the gate answers `hold` again
 * and it stays paused, which is why this can be a blunt sweep rather than a
 * query that has to understand the rules.
 */
export async function releaseElapsedWaits(now: Date = new Date()): Promise<{ released: number }> {
  const held = await db
    .selectFrom('workflow_jobs')
    .select(['id', 'workflow_run_id', 'settings', 'kind', 'started_at'])
    .where('state', '=', 'paused')
    .limit(500)
    .execute()
    .catch(() => [])

  let released = 0

  for (const job of held) {
    // A `block:` gate is a person's decision and has no timer. Only a command
    // job holding at an environment is this sweep's business.
    if (String(job.kind ?? 'command') !== 'command')
      continue

    if (!environmentOf(job.settings))
      continue

    await db
      .updateTable('workflow_jobs')
      .set({ state: 'blocked' })
      .where('id', '=', Number(job.id))
      .where('state', '=', 'paused')
      .execute()

    /*
     * Re-settling is what decides. If the timer has not elapsed, or a reviewer
     * is still required, the gate says `hold` again and the job is paused
     * within the same sweep - so a job is never left queued by a rule that
     * still holds it.
     */
    await settleRun(Number(job.workflow_run_id), now)

    const after = await db
      .selectFrom('workflow_jobs')
      .select(['state'])
      .where('id', '=', Number(job.id))
      .executeTakeFirst()
      .catch(() => null)

    if (after && String(after.state) !== 'paused')
      released += 1
  }

  return { released }
}

/** The environment a job named, out of its settings column. */
function environmentOf(settings: unknown): string {
  try {
    const parsed = JSON.parse(String(settings ?? '{}'))

    return parsed && typeof parsed === 'object' && typeof parsed.environment === 'string' ? parsed.environment : ''
  }
  catch {
    return ''
  }
}
