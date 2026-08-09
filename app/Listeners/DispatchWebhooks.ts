import type { EventSubject, NotificationEvent } from '../Notifications/definitions'
import { subscribes, webhookPayload } from '../Webhooks/payloads'

/**
 * Fan one domain event out to every webhook that asked for it.
 *
 * A second listener beside `Notify` rather than a branch inside it, because the
 * two answer different questions and fail differently. Notifying a person is
 * about subscriptions and quiet hours; calling somebody's server is about
 * signatures, timeouts and SSRF. Sharing a listener would mean one failure
 * could cost the other, and the inbox is the channel that has to work when
 * everything else does not.
 *
 * **The body is built here, once, and the exact string is what gets signed.**
 * Serializing per webhook would produce a different string for each - key order
 * is stable in practice but not guaranteed across engines - and a signature the
 * receiver cannot reproduce is worse than no signature, because it teaches them
 * to stop checking.
 *
 * Never throws. A webhook is a consequence of somebody's action and must not be
 * able to fail it: by the time this runs a branch has moved and a row says
 * merged.
 */
export default {
  listensTo: [
    'pr:opened',
    // Webhook-only, both of them: a program's questions, not a colleague's.
    // See the note beside them in `app/Events.ts`.
    'pr:synchronized',
    'pr:ready_for_review',
    'pr:merged',
    'pr:closed',
    'review:requested',
    'review:submitted',
    'issue:opened',
    'issue:closed',
    'comment:created',
    'release:published',
  ],

  async handle(payload: EventSubject & { event?: NotificationEvent }, eventName?: string): Promise<void> {
    try {
      // Both accepted for the reason written in `Notify`: the two event
      // libraries in play disagree about whether a handler is told which event
      // fired, and guessing wrong sends every webhook typed as the first case.
      const event = String(payload.event ?? eventName ?? '')
      const repositoryId = Number(payload.repositoryId ?? 0)

      if (!event || !repositoryId)
        return

      const hooks: any[] = await db
        .selectFrom('webhooks')
        .select(['id', 'events'])
        .where('repository_id', '=', repositoryId)
        .where('active', '=', true)
        .execute()

      if (hooks.length === 0)
        return

      // Filtered here rather than in SQL. The subscription list is a
      // comma-joined string, and `LIKE '%pr:opened%'` would match a webhook
      // subscribed to nothing but a repository whose *name* contained it.
      const wanted = hooks.filter(hook => subscribes(String(hook.events ?? ''), event))

      if (wanted.length === 0)
        return

      const body = JSON.stringify(webhookPayload(event, payload, new Date().toISOString()))
      const { default: DeliverWebhookJob } = await import('../Jobs/DeliverWebhookJob')

      for (const hook of wanted) {
        // One delivery id per webhook, not per event. A receiver deduplicates on
        // it, and two receivers sharing one id would each see the other's
        // retries as their own.
        await DeliverWebhookJob.dispatch({
          webhookId: Number(hook.id),
          event,
          body,
          deliveryId: crypto.randomUUID(),
          attempt: 1,
        })
      }
    }
    catch (error) {
      // Reported rather than swallowed. A webhook that quietly stopped firing
      // is the failure people notice weeks later, in somebody else's CI.
      console.error('[webhooks] could not dispatch:', error)
    }
  },
}
