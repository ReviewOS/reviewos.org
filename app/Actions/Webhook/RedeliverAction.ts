import { Action } from '@stacksjs/actions'
import { authorizeRepository } from '../Repo/authorize'

/**
 * Send one recorded delivery again.
 *
 * **The stored payload is replayed byte for byte, not rebuilt.** Rebuilding it
 * would send today's state under yesterday's event name, which is a different
 * message wearing the same label - and the receiver, who is redelivering
 * precisely because they want to reprocess what they missed, would get
 * something that never happened. The signature is recomputed rather than
 * stored, because it is a function of those bytes and the current secret, and a
 * secret rotated since is the one the receiver is checking against now.
 *
 * A fresh delivery id, deliberately. Receivers deduplicate on it, so reusing
 * the original would have the redelivery silently discarded by exactly the
 * receivers who implemented deduplication correctly - which is to say the ones
 * who most deserve it to work.
 *
 * It starts at attempt 1 and follows the whole retry curve. A redelivery is a
 * delivery; there is no reason for it to be less durable than the original.
 */
export default new Action({
  name: 'RedeliverWebhook',
  description: 'Send a recorded webhook delivery again',
  method: 'POST',

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'repository:settings')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const deliveryId = Number(request.get('delivery_id'))

    if (!Number.isInteger(deliveryId) || deliveryId <= 0)
      return response.json({ error: 'A delivery is required' }, 422)

    const delivery = await db
      .selectFrom('webhook_deliveries')
      .select(['id', 'webhook_id', 'event', 'payload'])
      .where('id', '=', deliveryId)
      .executeTakeFirst()

    if (!delivery)
      return response.json({ error: 'No such delivery' }, 404)

    // The webhook has to belong to this repository. Without this the endpoint
    // would replay any delivery in the database to its own destination for
    // anybody who can administer any repository at all.
    const webhook = await db
      .selectFrom('webhooks')
      .select(['id', 'active'])
      .where('id', '=', Number(delivery.webhook_id))
      .where('repository_id', '=', Number(repository.id))
      .executeTakeFirst()

    if (!webhook)
      return response.json({ error: 'No such delivery' }, 404)

    // Refused rather than queued and dropped later. Somebody pressing redeliver
    // on a webhook they switched off is asking a question - "why is this not
    // working" - and the answer is the reason.
    if (!webhook.active)
      return response.json({ error: 'That webhook is switched off' }, 409)

    const { default: DeliverWebhookJob } = await import('../../Jobs/DeliverWebhookJob')

    await DeliverWebhookJob.dispatch({
      webhookId: Number(webhook.id),
      event: String(delivery.event ?? ''),
      body: String(delivery.payload ?? ''),
      deliveryId: crypto.randomUUID(),
      attempt: 1,
    })

    if (wantsHtml(request))
      return response.redirect(request.header?.('referer') ?? '/')

    return response.json({ queued: true, webhook_id: Number(webhook.id) })
  },
})

/** Whether this arrived from a form rather than from fetch. */
function wantsHtml(request: RequestInstance): boolean {
  const accept = String(request.header?.('accept') ?? request.headers?.get?.('accept') ?? '')

  return accept.includes('text/html')
}
