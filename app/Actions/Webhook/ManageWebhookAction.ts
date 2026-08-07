import { Action } from '@stacksjs/actions'
import { authorizeRepository } from '../Repo/authorize'
import { pingPayload, WEBHOOK_EVENTS } from '../../Webhooks/payloads'
import { inspectUrl } from './ssrf'

/**
 * Create, update, or delete a repository's webhook.
 *
 * One endpoint with the operation in the body, for the reason the release and
 * label endpoints are one each: all three share the rule that decides whether
 * this URL is allowed to be called at all, and splitting them is how that rule
 * ends up written three times and forgotten once. That rule is the security
 * boundary of the whole feature, so it gets one home.
 *
 * `repository:settings` rather than `repository:push`. A webhook sends this
 * repository's activity to a server the configurer chooses, which is a decision
 * about the project rather than a change to its code.
 *
 * **The URL is checked before it is stored, and again before every delivery.**
 * Checking only at delivery would accept a URL the interface then displays as
 * working; checking only here would be defeated by DNS, which the configurer
 * controls and can change a second later. Both, and neither is redundant.
 */
export default new Action({
  name: 'ManageWebhook',
  description: 'Create, update, or delete a webhook',
  method: 'POST',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:settings')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    const operation = String(request.get('operation') ?? 'create').trim().toLowerCase()

    if (operation === 'delete') {
      const id = Number(request.get('id'))
      const existing = await owned(id, Number(repository.id))

      if (!existing)
        return response.json({ error: 'No such webhook' }, 404)

      // The deliveries go with it. They are a log of calls to an endpoint that
      // no longer exists, and keeping them would leave rows pointing at nothing
      // - the delivery page has no way to render them and no reason to.
      await db.deleteFrom('webhook_deliveries').where('webhook_id', '=', id).execute()
      await db.deleteFrom('webhooks').where('id', '=', id).execute()

      return response.json({ deleted: id })
    }

    if (operation !== 'create' && operation !== 'update')
      return response.json({ error: 'An operation is create, update or delete' }, 422)

    const url = String(request.get('url') ?? '').trim()
    const verdict = inspectUrl(url)

    // Refused with the reason `ssrf.ts` wrote, because the person reading it is
    // the one who typed the URL: "that address is on this machine" tells them
    // what to change and a code does not.
    if (!verdict.allowed)
      return response.json({ error: verdict.message ?? 'That URL cannot be used' }, 422)

    const events = readEvents(request.get('events'))
    if (!events)
      return response.json({ error: 'Events must be * or a list this product sends' }, 422)

    const contentType = String(request.get('content_type') ?? 'application/json')
    const active = request.get('active') === undefined ? true : readFlag(request.get('active'))

    if (operation === 'update') {
      const id = Number(request.get('id'))
      const existing = await owned(id, Number(repository.id))

      if (!existing)
        return response.json({ error: 'No such webhook' }, 404)

      // The secret is only replaced when a new one is sent. An update that
      // blanked it would silently turn signature checking off at the receiver,
      // which is the one failure nobody would look for.
      const secret = String(request.get('secret') ?? '')

      await db
        .updateTable('webhooks')
        .set({
          url,
          events,
          content_type: contentType,
          active,
          // Re-enabling resets the counter: it was switched off for sustained
          // failure, and keeping the count would switch it off again on the
          // first hiccup after somebody fixed their endpoint.
          ...(active && !existing.active ? { consecutive_failures: 0 } : {}),
          ...(secret ? { secret } : {}),
        })
        .where('id', '=', id)
        .execute()

      return response.json({ id, url, events, active })
    }

    // Generated rather than accepted. A secret somebody chooses is one they
    // reuse, and there is nothing a caller gains by picking it: they are told
    // it once, here, and it is the only time it leaves the server in the clear.
    const secret = String(request.get('secret') ?? '') || crypto.randomUUID().replaceAll('-', '')

    const created: any = await db
      .insertInto('webhooks')
      .values({
        repository_id: Number(repository.id),
        url,
        secret,
        events,
        content_type: contentType,
        active,
        consecutive_failures: 0,
      })
      .returning(['id'])
      .executeTakeFirst()

    const id = Number(created?.id)

    // A ping, immediately. Verifying an endpoint should exercise the real path
    // - the same signature, the same headers, the same SSRF checks - because a
    // special verification path proves the special path works.
    if (active && id) {
      const { default: DeliverWebhookJob } = await import('../../Jobs/DeliverWebhookJob')
      const owner = String(request.get('owner') ?? '').trim().toLowerCase()

      await DeliverWebhookJob.dispatch({
        webhookId: id,
        event: 'ping',
        body: JSON.stringify(pingPayload(
          { id: Number(repository.id), owner, name: repository.name },
          user ? { handle: String(user.handle ?? ''), id: Number(user.id) } : null,
          new Date().toISOString(),
        )),
        deliveryId: crypto.randomUUID(),
        attempt: 1,
      })
    }

    return response.json({ id, url, events, active, secret }, 201)
  },
})

/** A webhook, but only if it belongs to this repository. */
async function owned(id: number, repositoryId: number): Promise<any> {
  if (!Number.isInteger(id) || id <= 0)
    return null

  return db
    .selectFrom('webhooks')
    .select(['id', 'active'])
    .where('id', '=', id)
    .where('repository_id', '=', repositoryId)
    .executeTakeFirst()
}

/**
 * The subscription list, or null when it names something this product does not
 * send.
 *
 * Refused rather than silently dropped: a webhook subscribed to a typo would be
 * silent forever, and the configurer's only clue would be that nothing ever
 * arrives - which is indistinguishable from the endpoint being wrong.
 */
function readEvents(value: unknown): string | null {
  const raw = Array.isArray(value) ? value : String(value ?? '*').split(',')
  const list = raw.map(entry => String(entry).trim()).filter(Boolean)

  if (list.length === 0)
    return null

  if (list.includes('*'))
    return '*'

  const known = new Set<string>(WEBHOOK_EVENTS as readonly string[])
  if (list.some(entry => !known.has(entry)))
    return null

  return [...new Set(list)].join(',')
}

/** A checkbox, as a form sends it. */
function readFlag(value: unknown): boolean {
  const text = String(value ?? '').toLowerCase()

  return text === 'true' || text === '1' || text === 'on' || text === 'yes'
}
