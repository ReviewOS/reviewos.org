import { dispatch } from '@stacksjs/events'
import { Job } from '@stacksjs/queue'
import { fetchMirror, isAncestor } from '../Actions/Mirror/fetch'
import { describeChanges, diffRefs, headOf, isForcePush, shouldDisable } from '../Actions/Mirror/sync'

/**
 * Bring one mirror up to date.
 *
 * Queued rather than run inline, because a fetch of a large repository takes
 * minutes and a webhook has to be answered in seconds. The webhook enqueues
 * this and returns; the scheduled sweep enqueues it too, and the two overlapping
 * is the normal case rather than a problem - the second one finds nothing to
 * fetch and says so.
 *
 * Failure is recorded on the mirror rather than only logged. A mirror that
 * silently stopped updating is worse than one that visibly failed: either way
 * the reader trusts what they are looking at, and only one of them tells them
 * not to.
 */
export default new Job({
  name: 'MirrorSync',
  description: 'Fetch a mirrored repository and record what changed',
  queue: 'mirrors',
  tries: 3,
  backoff: 30,

  async handle(payload: { mirrorId: number }) {
    const mirrorId = Number(payload?.mirrorId)
    if (!Number.isFinite(mirrorId))
      return { ok: false, reason: 'no mirror id' }

    const mirror: any = await db
      .selectFrom('repository_mirrors')
      .selectAll()
      .where('id', '=', mirrorId)
      .executeTakeFirst()

    if (!mirror)
      return { ok: false, reason: 'mirror not found' }

    if (!mirror.enabled)
      return { ok: false, reason: 'mirror disabled' }

    const repository: any = await db
      .selectFrom('repositories')
      .selectAll()
      .where('id', '=', Number(mirror.repository_id))
      .executeTakeFirst()

    if (!repository)
      return { ok: false, reason: 'repository not found' }

    const diskPath = String(repository.disk_path ?? '')
    const outcome = await fetchMirror(diskPath, String(mirror.remote_url))

    if (!outcome.ok) {
      const failures = Number(mirror.failure_count ?? 0) + 1

      await db
        .updateTable('repository_mirrors')
        .set({
          last_error: outcome.error,
          failure_count: failures,
          // Giving up is a statement, not a silence: last_error stays so the
          // interface can say the mirror stopped and why.
          enabled: shouldDisable(failures) ? false : mirror.enabled,
        })
        .where('id', '=', mirrorId)
        .execute()

      dispatch('mirror:failed', { mirrorId, repositoryId: repository.id, error: outcome.error })
      return { ok: false, reason: outcome.error }
    }

    const changes = diffRefs(outcome.before, outcome.after)

    // A rewrite of the branch people actually look at is worth reporting; a
    // rewrite of someone's topic branch is noise.
    const defaultBranch = String(repository.default_branch ?? 'main')
    const headChange = changes.find(c => c.ref === `refs/heads/${defaultBranch}` && c.kind === 'updated')
    const rewrote = headChange
      ? isForcePush(headChange, await isAncestor(diskPath, headChange.before!, headChange.after!))
      : false

    await db
      .updateTable('repository_mirrors')
      .set({
        last_synced_at: new Date().toISOString(),
        last_sha: headOf(outcome.after, defaultBranch),
        last_error: null,
        failure_count: 0,
      })
      .where('id', '=', mirrorId)
      .execute()

    if (changes.length > 0) {
      await db
        .updateTable('repositories')
        .set({ pushed_at: new Date().toISOString() })
        .where('id', '=', Number(repository.id))
        .execute()
    }

    dispatch('mirror:synced', {
      mirrorId,
      repositoryId: repository.id,
      changes: changes.length,
      summary: describeChanges(changes),
      rewroteHistory: rewrote,
    })

    return { ok: true, changes: changes.length, summary: describeChanges(changes), rewroteHistory: rewrote }
  },
})
