import { Job } from '@stacksjs/queue'
import { isDue } from '../Actions/Mirror/sync'

/**
 * Enqueue a sync for every mirror that is due.
 *
 * The backstop behind the webhook. A hook can be missed - a delivery fails, a
 * secret rotates, a repository is transferred - and a mirror that quietly stops
 * updating looks exactly like one that has nothing new. The sweep guarantees a
 * ceiling on how stale a mirror can get regardless.
 *
 * It enqueues rather than fetches, so one slow repository cannot hold up the
 * rest, and a sweep overlapping a webhook-triggered sync is fine: the second
 * one finds nothing to fetch.
 */
export default new Job({
  name: 'MirrorSweep',
  description: 'Enqueue a sync for every mirror whose interval has elapsed',
  queue: 'mirrors',
  tries: 1,

  async handle() {
    const mirrors: any[] = await db
      .selectFrom('repository_mirrors')
      .selectAll()
      .where('enabled', '=', true)
      .execute()

    const now = new Date()
    let queued = 0

    for (const mirror of mirrors) {
      // Due-ness lives in sync.ts, where it is tested, rather than as a SQL
      // predicate that would have to encode the backoff curve too.
      if (!isDue({
        enabled: Boolean(mirror.enabled),
        interval_seconds: Number(mirror.interval_seconds ?? 900),
        last_synced_at: mirror.last_synced_at ? String(mirror.last_synced_at) : null,
        failure_count: Number(mirror.failure_count ?? 0),
      }, now)) continue

      await MirrorSyncJob.dispatch({ mirrorId: Number(mirror.id) })
      queued += 1
    }

    return { considered: mirrors.length, queued }
  },
})
