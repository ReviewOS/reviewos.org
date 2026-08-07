import type { EventSubject, NotificationEvent } from '../Notifications/definitions'
import { describe } from '../Notifications/definitions'
import { recipientsFor } from '../Notifications/recipients'

/**
 * Turn a domain event into inbox entries.
 *
 * One listener for all nine events rather than one each, because the work is
 * identical every time: find who is subscribed and why, drop the person who
 * caused it, write a row. What differs is the sentence, and that lives in
 * `app/Notifications/definitions.ts` next to the others where they can be read
 * against each other.
 *
 * Writes to `notifications` directly rather than dispatching a job. That is the
 * inbox, it is one insert per recipient, and it is the channel that has to work
 * when nothing else does - a reader who opens the product should see what
 * happened whether or not mail is configured, a worker is running, or the
 * network is up. Email and push hang off `SendNotificationJob` when the queue
 * can reserve, and are the channels that *should* be deferred.
 *
 * Never throws. A notification is a consequence of somebody else's action, and
 * failing to record one must not fail the action that caused it: merging a pull
 * request has already moved a branch by the time this runs.
 */
export default {
  listensTo: [
    'pr:opened',
    'pr:merged',
    'pr:closed',
    'review:requested',
    'review:submitted',
    'issue:opened',
    'issue:closed',
    'comment:created',
    'release:published',
  ],

  async handle(payload: EventSubject & { event?: NotificationEvent, addressed?: number[] }, eventName?: string): Promise<void> {
    try {
      // The emitter names the event; the listener is told which one fired. Both
      // are accepted because the two event libraries in play disagree about
      // which, and guessing wrong means every notification is typed as the
      // first case in the switch.
      const event = (payload.event ?? eventName) as NotificationEvent | undefined
      if (!event)
        return

      const notification = describe(event, payload)
      if (!notification)
        return

      const recipients = await recipientsFor({
        event,
        subjectType: payload.subjectType,
        subjectId: payload.subjectId,
        actorId: payload.actorId,
        addressed: payload.addressed,
      })

      if (recipients.length === 0)
        return

      // Everything the widest mute has to be able to reach: this thread, and
      // the repository it lives in. Both travel with the job rather than being
      // re-derived, because by the time a worker picks it up the pull request
      // may have been merged and the row it would have looked at is gone.
      const subjects = [
        { type: payload.subjectType as any, id: Number(payload.subjectId) },
        ...(payload.repositoryId ? [{ type: 'repository' as const, id: Number(payload.repositoryId) }] : []),
      ]

      for (const recipient of recipients) {
        await db.insertInto('notifications').values({
          user_id: recipient.userId,
          type: notification.type,
          // The reason travels with the row, so the inbox can say why this
          // arrived without joining back to a subscription that may since have
          // been unsubscribed.
          data: JSON.stringify({
            title: notification.title,
            url: notification.url,
            reason: recipient.reason,
            repository: `${payload.owner}/${payload.repository}`,
            number: payload.number ?? null,
          }),
        }).execute()

        // The interrupting channels, queued. Whether either actually sends is
        // decided in the job, when it runs, rather than here - preferences,
        // quiet hours and mutes all move between the moment something happens
        // and the moment a worker picks it up, and the answer that matters is
        // the one true when the message would arrive. Deciding now is how mail
        // goes out at 03:00 that was correct at 22:00.
        for (const channel of ['email', 'push'] as const) {
          await queueDelivery({
            userId: recipient.userId,
            event,
            channel,
            title: notification.title,
            url: notification.url,
            subjects,
          })
        }
      }
    }
    catch (error) {
      // Reported rather than swallowed. A queue that silently stopped
      // delivering is the failure this codebase has already been bitten by, and
      // an inbox that quietly stops filling is the same shape.
      console.error('[notify] could not record notifications:', error)
    }
  },
}

/**
 * Queue one interrupting delivery.
 *
 * Isolated so a queue that cannot accept a job does not cost somebody the inbox
 * row that was already written. The inbox is the record; email and push are
 * best effort on top of it, and a broken worker must not be able to turn the
 * record into nothing.
 *
 * Imported lazily for the same reason `emit.ts` is: this listener runs inside
 * the action that caused the event, and pulling the queue's module graph in at
 * import time would put it on the critical path of every write in the product.
 */
async function queueDelivery(payload: Record<string, unknown>): Promise<void> {
  try {
    const SendNotificationJob = (await import('../Jobs/SendNotificationJob')).default

    await SendNotificationJob.dispatch(payload as any)
  }
  catch (error) {
    console.error('[notify] could not queue a delivery:', error)
  }
}
