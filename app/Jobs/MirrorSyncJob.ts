import { dispatch } from '@stacksjs/events'
import { Job } from '@stacksjs/queue'
import { fetchMirror, isAncestor } from '../Actions/Mirror/fetch'
import { describeChanges, diffRefs, headOf, isForcePush, shouldDisable } from '../Actions/Mirror/sync'
import { cancelRequested, markCancelled, markFailed, markRunning, markSucceeded } from '../Api/progress'

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

  /**
   * Reports into the operation the caller is polling, when there is one.
   *
   * A wrapper rather than a status write at each of the five return points:
   * the fifth is the one somebody forgets, and a caller left polling `running`
   * forever has no way to tell that from work that is genuinely still going.
   *
   * `operationId` is absent for the scheduled sweep and for a webhook, which
   * nobody is watching. Every helper here no-ops on a missing id, so there is
   * no branch to get wrong.
   */
  async handle(payload: { mirrorId: number, operationId?: number }) {
    const operationId = Number(payload?.operationId) || null

    // A cancel that arrived while it sat in the queue. Checked before the fetch
    // rather than after, because the fetch is the expensive part and the whole
    // point of cancelling was not to do it.
    if (await cancelRequested(operationId)) {
      await markCancelled(operationId)
      return { ok: false, reason: 'cancelled' }
    }

    await markRunning(operationId)

    try {
      const outcome = await run(payload)

      if (outcome.ok)
        await markSucceeded(operationId, outcome)
      else
        await markFailed(operationId, String((outcome as any).reason ?? 'the sync failed'))

      return outcome
    }
    catch (error) {
      // Recorded and rethrown. The queue's retry is the queue's business, and
      // swallowing the throw here would turn a retryable failure into a
      // permanent one that reports success.
      await markFailed(operationId, error instanceof Error ? error.message : String(error))
      throw error
    }
  },
})

/** The sync itself, unchanged. */
async function run(payload: { mirrorId: number }): Promise<{ ok: boolean, reason?: string, changes?: number, summary?: string, rewroteHistory?: boolean }> {
  {
    const mirrorId = Number(payload?.mirrorId)
    if (!Number.isFinite(mirrorId))
      return { ok: false, reason: 'no mirror id' }

    const mirror = await db
      .selectFrom('repository_mirrors')
      .selectAll()
      .where('id', '=', mirrorId)
      .executeTakeFirst()

    if (!mirror)
      return { ok: false, reason: 'mirror not found' }

    if (!mirror.enabled)
      return { ok: false, reason: 'mirror disabled' }

    const repository = await db
      .selectFrom('repositories')
      .selectAll()
      .where('id', '=', Number(mirror.repository_id))
      .executeTakeFirst()

    if (!repository)
      return { ok: false, reason: 'repository not found' }

    /*
     * Resolved from the owner and the name, not read out of `disk_path`.
     *
     * `disk_path` is an absolute path recorded when the row was written, and on
     * a deploy-by-release layout that is a path inside whichever release was
     * current at the time - `.../releases/f246ff0/storage/repos/...`. The
     * release is replaced on the next deploy, so the column is stale within
     * hours and the fetch fails with "not a git repository" against a
     * directory that genuinely no longer exists, while the repository sits
     * untouched in shared storage.
     *
     * Everything else in this codebase already resolves the path this way -
     * `findRepositoryByPath`, `repositoryForView`, the git wire routes - which
     * is why repository *pages* worked while only the sync failed. This is the
     * one reader that trusted the column.
     */
    const { repositoryPath } = await import('../Actions/Git/storage')
    const { ownerHandleFor } = await import('../Actions/Repo/owner')
    const ownerHandle = await ownerHandleFor(repository)
    const resolved = ownerHandle ? repositoryPath(ownerHandle, String(repository.name)) : { ok: false as const }

    if (!resolved.ok || !resolved.path)
      return { ok: false, reason: 'repository path did not resolve' }

    const diskPath = resolved.path

    /*
     * The credential, which the git side never had.
     *
     * The metadata sync resolved a token and this did not, so a private mirror
     * imported its issues perfectly and cloned nothing - which reads as "the
     * repository is empty" rather than as "the credential never reached git".
     * A public mirror resolves to null and the URL is unchanged, so the path
     * that already worked is untouched.
     */
    const { authenticatedUrl, mirrorToken, redact } = await import('../Actions/Mirror/credentials')
    const token = await mirrorToken(mirror.credential_ref)
    // The provider decides whether pull request heads come across, and under
    // what name: they are not on any branch, so without it the mirror has the
    // proposals' titles and none of their commits.
    const outcome = await fetchMirror(
      diskPath,
      authenticatedUrl(String(mirror.remote_url), token),
      { provider: String(mirror.provider ?? '') },
    )

    if (!outcome.ok) {
      const failures = Number(mirror.failure_count ?? 0) + 1

      await db
        .updateTable('repository_mirrors')
        .set({
          /*
           * Redacted before it is stored.
           *
           * git echoes the remote URL in most of its failures, and this column
           * is shown in the interface - so the ordinary first failure of a
           * private mirror, a 403 from an expired token, would otherwise write
           * a live credential into the database and onto a page.
           */
          last_error: redact(outcome.error ?? '', token),
          failure_count: failures,
          // Giving up is a statement, not a silence: last_error stays so the
          // interface can say the mirror stopped and why.
          enabled: shouldDisable(failures) ? false : mirror.enabled,
        })
        .where('id', '=', mirrorId)
        .execute()

      dispatch('mirror:failed', { mirrorId, repositoryId: repository.id, error: outcome.error })
      // `?? undefined` rather than the null the fetch reports: the wrapper reads
      // `reason` as the sentence it records, and "null" is not one.
      return { ok: false, reason: outcome.error ?? undefined }
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

    /*
     * What the repository is written in, and who wrote it - re-measured when a
     * sync actually moved something.
     *
     * A mirror never goes through `ProcessPushJob`, which is the only thing
     * that queued these, so **no mirrored repository has ever had a language
     * breakdown or a contributor list**. That is most of the repositories on an
     * instance like this one, and the symptom is an About panel with two
     * sections missing on exactly the repositories people came to look at.
     *
     * When refs moved, **or when nothing has ever measured this repository**.
     *
     * The change check alone is not enough, and the case it misses is the
     * common one on an instance whose mirrors are already up to date: a
     * repository that syncs cleanly and finds nothing new would never be
     * measured at all, so its About panel would stay blank forever - waiting
     * for an upstream commit to make this forge notice a history that has been
     * sitting on disk the whole time. Every one of the 151 mirrors here is in
     * exactly that state today.
     *
     * The "never measured" read is one indexed count against a table that is
     * empty for precisely the repositories that need it, and it is only reached
     * when nothing changed - so a busy mirror pays nothing for it.
     *
     * Separately caught, and after the row is already updated: these are two
     * conveniences, and neither is worth turning a successful sync into a
     * retry.
     */
    if (changes.length > 0 || await neverMeasured(Number(repository.id))) {
      for (const name of ['MeasureLanguagesJob', 'MeasureContributorsJob'] as const) {
        try {
          const job = (await import(`./${name}`)).default

          await job.dispatch({ repositoryId: Number(repository.id) })
        }
        catch (error) {
          console.error(`[mirror] could not queue ${name}:`, error)
        }
      }
    }

    dispatch('mirror:synced', {
      mirrorId,
      repositoryId: repository.id,
      changes: changes.length,
      summary: describeChanges(changes),
      rewroteHistory: rewrote,
    })

    return { ok: true, changes: changes.length, summary: describeChanges(changes), rewroteHistory: rewrote }
  }
}

/**
 * Whether anything has ever worked out what this repository is.
 *
 * Both tables at once, because a repository measured for languages and not for
 * contributors is exactly what an instance looks like the day after the second
 * measure is added - and asking only about the first would leave it that way.
 *
 * A read that fails is answered `false`: the cost of guessing wrong here is a
 * measure that does not run this sweep and runs on the next one, and the cost
 * of the opposite guess is re-walking every history on every sweep forever.
 */
async function neverMeasured(repositoryId: number): Promise<boolean> {
  try {
    const [languages, contributors] = await Promise.all([
      db.selectFrom('repository_languages').select(['id']).where('repository_id', '=', repositoryId).limit(1).executeTakeFirst(),
      db.selectFrom('repository_contributors').select(['id']).where('repository_id', '=', repositoryId).limit(1).executeTakeFirst(),
    ])

    return !languages || !contributors
  }
  catch {
    return false
  }
}
