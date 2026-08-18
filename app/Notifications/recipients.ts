/**
 * Who hears about something, and why.
 *
 * Subscription is implicit - opening, commenting on, or being assigned to
 * something subscribes you - so this reads the subscriptions rather than asking
 * anybody to have opted in. The `reason` on each row is carried through to the
 * notification, because "you are receiving this because you commented" is the
 * sentence people act on when they want less mail. Without it the only response
 * available is muting everything, which is what people do.
 *
 * Two rules are enforced here rather than at each call site, because there are
 * nine call sites and the tenth is always the one that forgets:
 *
 * - **Nobody is notified about their own action.** Every event carries an
 *   actor, and the actor is removed unconditionally.
 * - **An explicit unsubscribe wins.** The row is kept rather than deleted
 *   precisely so a later comment cannot quietly resubscribe somebody who opted
 *   out, and reading it as anything other than final would waste that.
 */

import type { NotificationEvent } from './definitions'
import { reasonsFor } from './definitions'

export interface Recipient {
  userId: number
  /** Why they are hearing about it, for the sentence in the interface. */
  reason: string
}

/**
 * Everybody subscribed to a subject who should hear about this event.
 *
 * The `reasons` filter is applied in SQL rather than after, so a repository
 * with four hundred watchers does not load four hundred rows to discard most of
 * them on a comment.
 */
export async function recipientsFor(options: {
  event: NotificationEvent
  subjectType: 'issue' | 'pull_request' | 'repository'
  subjectId: number
  actorId: number
  /** Named directly, whatever they are subscribed to. A review request. */
  addressed?: number[]
}): Promise<Recipient[]> {
  const allowed = reasonsFor(options.event)

  let query = db
    .selectFrom('notification_subscriptions')
    .select(['user_id', 'reason'])
    .where('subject_type', '=', options.subjectType)
    .where('subject_id', '=', options.subjectId)
    // `unsubscribed` is a row rather than a deletion, so it has to be read.
    .where('unsubscribed', '=', false)

  if (allowed !== 'all')
    query = query.where('reason', 'in', allowed)

  const rows: any[] = await query.execute()

  const byUser = new Map<number, string>()

  for (const row of rows) {
    const userId = Number(row.user_id)
    if (!userId || userId === options.actorId)
      continue

    // One person can be subscribed twice - the author who also commented. The
    // first reason wins, and the ordering is the subscription's own, so the
    // reason somebody acquired first is the one they are told about.
    if (!byUser.has(userId))
      byUser.set(userId, String(row.reason))
  }

  // Somebody asked directly is added even if they were never subscribed, which
  // is what makes a review request reach a person who has not touched the
  // repository. Still never the actor.
  for (const userId of options.addressed ?? []) {
    if (userId && userId !== options.actorId)
      byUser.set(userId, 'review_requested')
  }

  if (byUser.size === 0)
    return []

  // Anybody whose account has gone, or who has muted this repository, is not a
  // recipient. Checked here rather than at delivery, so a muted repository
  // costs nothing per channel rather than once per channel.
  const live = await db
    .selectFrom('users')
    .select(['id'])
    .where('id', 'in', [...byUser.keys()])
    .execute()

  return live.map(row => ({ userId: Number(row.id), reason: byUser.get(Number(row.id)) ?? 'participating' }))
}

/**
 * Subscribe somebody to a subject, if they are not already.
 *
 * Called when they do the thing that implies it: open, comment, get assigned.
 * Never overwrites an existing row - the first reason is the truest one, and an
 * update would also quietly clear an `unsubscribed` somebody set deliberately.
 */
export async function subscribe(options: {
  userId: number
  subjectType: 'issue' | 'pull_request' | 'repository'
  subjectId: number
  reason: string
}): Promise<void> {
  if (!options.userId || !options.subjectId)
    return

  const existing = await db
    .selectFrom('notification_subscriptions')
    .select(['id'])
    .where('user_id', '=', options.userId)
    .where('subject_type', '=', options.subjectType)
    .where('subject_id', '=', options.subjectId)
    .executeTakeFirst()

  if (existing)
    return

  await db.insertInto('notification_subscriptions').values({
    user_id: options.userId,
    subject_type: options.subjectType,
    subject_id: options.subjectId,
    reason: options.reason,
    unsubscribed: false,
  }).execute()
}
