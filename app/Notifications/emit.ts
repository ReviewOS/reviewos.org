/**
 * Emitting a domain event, from the one place the state changed.
 *
 * A thin helper rather than nine call sites each assembling a payload, because
 * the payload has eight fields and the two that matter most - who caused it, and
 * what it is about - are the two an inline object gets wrong. Getting `actorId`
 * wrong means notifying somebody about their own action, which is the fastest
 * way to teach people to ignore notifications.
 *
 * **Emitted after the write, never before.** Every caller here has already
 * changed something by the time it runs: a branch has moved, a row says merged.
 * An event sent first and then rolled back is a notification about something
 * that did not happen, and there is no way to take it back.
 *
 * **Never throws.** A notification is a consequence of somebody's action and
 * must not be able to fail it. `dispatch` is synchronous under the current
 * queue driver, so an exception here would propagate into the action that
 * caused it and report a failure for something that succeeded.
 */

import type { EventSubject, NotificationEvent } from './definitions'
import { dispatch } from '@stacksjs/events'
import { subscribe } from './recipients'

export interface EmitOptions extends EventSubject {
  /** People to reach whatever they are subscribed to. A requested reviewer. */
  addressed?: number[]
  /**
   * Subscribe the actor to what they just touched.
   *
   * Opening, commenting on, or being assigned to something subscribes you, and
   * the reason is recorded so the notification can say why it arrived. Off for
   * events where the actor is acting *on* somebody else's thread without
   * joining it - closing a stale issue should not sign you up for the rest of
   * the conversation.
   */
  subscribeActor?: string | false
}

export async function notify(event: NotificationEvent, options: EmitOptions): Promise<void> {
  try {
    if (options.subscribeActor) {
      await subscribe({
        userId: options.actorId,
        subjectType: options.subjectType,
        subjectId: options.subjectId,
        reason: options.subscribeActor,
      })
    }

    // Anybody addressed directly is subscribed too, so the next event on the
    // thread reaches them without being addressed again. A reviewer asked once
    // should hear about the reply to their own comment.
    for (const userId of options.addressed ?? []) {
      await subscribe({
        userId,
        subjectType: options.subjectType,
        subjectId: options.subjectId,
        reason: 'review_requested',
      })
    }

    // The event name travels in the payload as well as being the channel. The
    // listener needs it to pick a sentence, and the two event libraries in play
    // disagree about whether a handler is told which event fired.
    dispatch(event, { ...options, event })
  }
  catch (error) {
    console.error(`[notify] ${event} could not be emitted:`, error)
  }
}
