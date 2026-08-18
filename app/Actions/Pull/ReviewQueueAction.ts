import { Action } from '@stacksjs/actions'
import { currentUser } from '../Identity/lookup'
import { reviewQueue, waitingReason } from './queue'

/**
 * What is waiting on you, as data.
 *
 * `reviewQueue` has existed since the review queue was built and exactly one
 * caller reads it: `resources/views/reviews.stx`. That is the parity gap this
 * phase calls a bug rather than a design decision - the interface reaches
 * something the API cannot, so an agent asking the single most useful question
 * a reviewing agent has ("what should I look at?") had to either scrape the page
 * or reconstruct the ordering itself.
 *
 * The ordering is the valuable part and the part worth *not* re-deriving. It
 * weighs how long something has waited against whether the reader is blocking
 * it, and an agent that sorted by `created_at` would produce a plausible list
 * that is not the same list - which is worse than no endpoint, because it looks
 * right.
 *
 * Always the caller's own queue. There is no parameter naming somebody else,
 * so there is no check to forget.
 */
export default new Action({
  name: 'ReviewQueue',
  description: 'Pull requests waiting on the authenticated user',
  method: 'GET',

  async handle(request: RequestInstance) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    /*
     * One clock for the whole answer.
     *
     * The ordering, the ages and the sentences all read it, and taking it once
     * is what stops a list ordered against one instant being described against
     * another - "waiting 3 days" ranked below "waiting 2 days", which reads as
     * a broken sort rather than as two `Date.now()` calls.
     */
    const now = Date.now()
    const { waitingOnYou, waitingOnOthers } = await reviewQueue(user.id, now)

    const describe = (entry: Awaited<ReturnType<typeof reviewQueue>>['waitingOnYou'][number]) => ({
      ...entry,
      // The sentence the page shows, computed here rather than left to the
      // caller: a client deriving its own would drift from the order it was
      // handed.
      reason: waitingReason(entry, now),
    })

    return response.json({
      /*
       * Two lists, kept apart, because they are two questions.
       *
       * "What is blocked on me" is work; "what of mine is blocked on somebody
       * else" is a status. Flattening them into one array with a flag would
       * make the common case - an agent asking what to review - a filter that
       * every caller has to remember to apply.
       */
      waiting_on_you: waitingOnYou.map(describe),
      waiting_on_others: waitingOnOthers.map(describe),
      count: waitingOnYou.length,
    })
  },
})
