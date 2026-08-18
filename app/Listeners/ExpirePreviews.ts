import { expirePreviews } from '../Actions/Deploy/previews'

/**
 * A preview outlives its pull request by exactly nothing.
 *
 * The environment somebody stood up to review a change stops being interesting
 * the moment the change lands or is abandoned - and a preview nobody expires is
 * an instance covered in stale URLs, each of them costing whatever it costs to
 * keep running.
 *
 * Marking rather than deleting: "what was on this URL last Tuesday" is a
 * question people ask, and expressing "no longer running" by removing the
 * history answers it with silence.
 *
 * Fire-and-forget, like every listener here. A pull request is merged when the
 * merge happened, not when its previews have been tidied up.
 */
export default {
  listensTo: ['pr:merged', 'pr:closed'],

  async handle(payload: any): Promise<void> {
    try {
      const repositoryId = Number(payload?.repositoryId ?? 0)

      if (!repositoryId)
        return

      /*
       * Scoped to the pull request when the payload names one, and to the
       * repository otherwise. The second is not a fallback for tidiness: a
       * preview recorded by a deploy that finished after the merge is the
       * ordinary case, and sweeping the repository catches it on the next
       * event rather than leaving it live forever.
       */
      const pullRequestId = Number(payload?.subjectId ?? 0) || undefined

      await expirePreviews(repositoryId, pullRequestId)
    }
    catch (error) {
      console.error('[previews] could not expire a pull request\'s previews:', error)
    }
  },
}
