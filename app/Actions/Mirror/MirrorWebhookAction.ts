import { Action } from '@stacksjs/actions'
import { verifySignature } from '../Webhook/signing'
import { remoteKey, webhookTriggersSync } from './sync'

/**
 * Receive a webhook from an upstream forge and enqueue a sync.
 *
 * This is what makes a mirror feel immediate rather than eventually correct.
 * The scheduled sweep is the backstop; a hook is the fast path, and neither is
 * sufficient alone - a hook can be missed, and a sweep that ran often enough to
 * feel instant would be a poll.
 *
 * It answers immediately and does the work on a queue. A forge that does not
 * get its 200 quickly marks the delivery failed and starts retrying, so doing
 * the fetch inline turns one push into a pile of duplicate deliveries.
 */
export default new Action({
  name: 'MirrorWebhook',
  description: 'Receive an upstream webhook and enqueue a mirror sync',
  method: 'POST',

  async handle(request: any) {
    const event = String(request.headers?.get?.('x-github-event') ?? '')
    const signature = String(request.headers?.get?.('x-hub-signature-256') ?? '')

    // A ping is how GitHub checks the endpoint exists; answering it is the
    // difference between a hook that shows as healthy and one that shows red.
    if (event === 'ping')
      return response.json({ ok: true, pong: true })

    if (!webhookTriggersSync(event))
      return response.json({ ok: true, ignored: event })

    /*
     * The exact bytes, from `rawBody()`, which is a method and not a property.
     *
     * Re-serializing the parsed body is not byte-identical - key order, spacing
     * and unicode escapes all differ - so an HMAC computed over it fails against
     * every real delivery. `request.body` is worse still: on an `EnhancedRequest`
     * it is the `Request` stream, so `JSON.stringify` of it is the string `{}`
     * and the payload reads as empty.
     */
    const raw = await request.rawBody?.() ?? ''
    const payload = request.jsonBody ?? {}

    const owner = String(payload?.repository?.owner?.login ?? payload?.repository?.owner?.name ?? '')
    const name = String(payload?.repository?.name ?? '')
    if (!owner || !name)
      return response.json({ error: 'No repository in payload' }, 422)

    const key = remoteKey(owner, name)

    // Matching on owner/name rather than the URL: the same repository is
    // reachable as https, ssh, and with or without `.git`, and a mirror
    // configured with one spelling must still match a hook that used another.
    const candidates = await db
      .selectFrom('repository_mirrors')
      .selectAll()
      .where('enabled', '=', true)
      .execute()

    const mirror = candidates.find(m => remoteKey(String(m.remote_owner ?? ''), String(m.remote_name ?? '')) === key)
    if (!mirror)
      return response.json({ ok: true, ignored: 'no mirror for this repository' })

    /*
     * Verified against the mirror's own secret, and **no secret means no
     * sync.**
     *
     * This used to read `if (secret && !verifySignature(...))`, and the secret
     * it read was `credential_ref` - a column documented as a *reference* to a
     * credential rather than one, holding a readable name that looks up an
     * environment variable, and set by nothing. So the guard was skipped on
     * every mirror on every instance, and this unauthenticated endpoint would
     * queue a `git fetch` against an upstream for anybody who could name a
     * mirrored repository. Remote owner and name are public knowledge for
     * exactly the repositories people mirror.
     *
     * Two changes, and the second matters more than the first. The secret is
     * its own column now, generated rather than named. And an absent one fails
     * *closed*: the hook is ignored and the interval sweep still keeps the
     * mirror current, so the cost of a misconfiguration is latency rather than
     * an open door. A guard that switches itself off when unconfigured is not a
     * guard - it is a guard-shaped hole, and this was one.
     */
    const secret = String(mirror.webhook_secret ?? '')

    if (!secret) {
      return response.json({
        ok: true,
        ignored: 'this mirror has no webhook secret, so deliveries are not trusted',
      })
    }

    if (!verifySignature(raw, secret, signature))
      return response.json({ error: 'Bad signature' }, 401)

    /*
     * Imported, not reached for as a global.
     *
     * This line read `MirrorSyncJob.dispatch(...)` against the server
     * auto-import, and threw `ReferenceError: MirrorSyncJob is not defined` -
     * so the one statement that does the work in this endpoint failed with a
     * 500 whenever anything reached it. Every other action in this codebase
     * imports its job explicitly; this was the one that did not, and nothing
     * noticed because two other faults meant nothing ever got this far.
     */
    const MirrorSyncJob = (await import('../../Jobs/MirrorSyncJob')).default

    await MirrorSyncJob.dispatch({ mirrorId: Number(mirror.id) })

    return response.json({ ok: true, queued: Number(mirror.id), event })
  },
})
