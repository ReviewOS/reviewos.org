import { Job } from '@stacksjs/queue'
import { log } from '@stacksjs/logging'
import { reconcilePending } from '../Actions/Git/walReconcile'

/**
 * Settle the log entries nobody confirmed.
 *
 * A row is written `pending` before a push is allowed and moved to `committed`
 * when post-receive reports it landed. Between those two moments the process
 * can die, the hook can fail to reach the application, or the push can be
 * refused by git itself after this instance said yes - and each of those
 * leaves a row that is neither true nor false.
 *
 * **Left alone, `pending` rots into meaninglessness.** A log whose entries are
 * mostly pending cannot answer the one question it exists for - what did this
 * repository look like at sequence 40 - because it does not know which of them
 * happened. So this asks the only authority there is: the refs on disk. An
 * entry whose `after` sha is what the ref actually points at, or is an
 * ancestor of it, landed. One whose sha the repository has never heard of did
 * not.
 *
 * Nothing is deleted. A voided row keeps its reason and its bundle, because a
 * gap in a backup that nobody can explain is worse than a row that says "this
 * push was refused".
 */
export default new Job({
  name: 'ReconcileWalJob',
  description: 'Settle write-ahead log entries against the refs actually on disk',
  queue: 'git',
  tries: 1,

  async handle(payload: { olderThanMinutes?: number } = {}) {
    const outcome = await reconcilePending({
      olderThanMinutes: Number(payload?.olderThanMinutes ?? 10),
    })

    if (outcome.committed > 0 || outcome.voided > 0)
      log.info(`[wal] reconciled ${outcome.committed} landed and ${outcome.voided} abandoned entries`)

    return outcome
  },
})
