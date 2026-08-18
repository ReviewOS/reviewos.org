import { Action } from '@stacksjs/actions'
import { accepted, startOperation } from '../Api/start'
import { authorizeRepository } from '../Repo/authorize'

/**
 * Sync a mirror now, rather than at its next interval.
 *
 * The button exists because the interval is a compromise and the moment
 * somebody wants the mirror current is usually a moment they can name: they
 * just merged something upstream and want to review it here, or they fixed the
 * credential and want to know whether it worked.
 *
 * **Behind `repository:settings`**, the same rung that configures the mirror.
 * A sync spends somebody else's rate limit and can take minutes on a large
 * repository, so it is not a button for every reader - and a public mirror
 * whose sync anybody could trigger is a way to get an instance's token banned
 * by whoever it belongs to.
 *
 * **Rate limited to one manual sync a minute per mirror**, which is not about
 * abuse so much as about the button being pressed three times because nothing
 * visibly happened. Three sweeps of the same repository race each other into
 * the same refs.
 */
export const MANUAL_SYNC_COOLDOWN_MS = 60_000

export default new Action({
  name: 'MirrorSyncNow',
  description: 'Sync a mirrored repository immediately',
  method: 'POST',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:settings')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context

    const mirror = await db
      .selectFrom('repository_mirrors')
      .select(['id', 'enabled', 'last_synced_at', 'sync_metadata'])
      .where('repository_id', '=', Number(repository.id))
      .executeTakeFirst()

    if (!mirror)
      return response.json({ error: 'This repository is not a mirror' }, 404)

    // A disabled mirror is refused rather than quietly enabled. Somebody turned
    // it off, and one sync would make the repository current and then let it
    // drift again - which is more confusing than it staying visibly stale.
    if (!mirror.enabled)
      return response.json({ error: 'Syncing is switched off for this mirror. Enable it first.' }, 409)

    const last = mirror.last_synced_at ? Date.parse(String(mirror.last_synced_at)) : 0
    const waited = Date.now() - last

    if (last && waited < MANUAL_SYNC_COOLDOWN_MS) {
      return response.json({
        error: 'This mirror synced moments ago. Wait a minute before syncing again.',
        retry_in_seconds: Math.ceil((MANUAL_SYNC_COOLDOWN_MS - waited) / 1000),
      }, 429)
    }

    /*
     * Queued rather than run here. A sync is a `git fetch` against a remote
     * host and can take minutes on a large repository, and a request that holds
     * a connection open that long is a request that times out at whatever proxy
     * is in front of this - after which the sync completes and nobody is told.
     */
    /*
     * As an operation, which is the shape every long-running thing here wears.
     *
     * It used to answer `{ queued: true }`, which tells a caller nothing they
     * can act on: no way to ask whether it started, whether it finished, or why
     * it did not. A client's only recourse was to poll the mirror row and infer,
     * and a mirror that has not moved is indistinguishable from a sync that
     * never ran.
     *
     * An `Idempotency-Key` on the request joins the operation it already
     * started rather than beginning a second fetch of the same remote.
     */
    const { row, fresh } = await startOperation({
      kind: 'mirror.sync',
      subject: { type: 'repository', id: Number(repository.id) },
      actorId: auth.context.user?.id ?? null,
      request,
    })

    if (fresh) {
      const MirrorSyncJob = (await import('../../Jobs/MirrorSyncJob')).default
      await MirrorSyncJob.dispatch({ mirrorId: Number(mirror.id), operationId: Number(row.id) })

      if (mirror.sync_metadata) {
        const MirrorMetadataSyncJob = (await import('../../Jobs/MirrorMetadataSyncJob')).default
        await MirrorMetadataSyncJob.dispatch({ mirrorId: Number(mirror.id) })
      }
    }

    // `mirror_id` stays, because something already reads it. Adding a field is
    // safe; removing one is a breaking change to somebody else's script.
    return accepted(row, { mirror_id: Number(mirror.id) })
  },
})
